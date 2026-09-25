"""노래공방 생성 워커.

stdin 으로 JSON 명령을 한 줄씩 받고, stdout 으로 JSON 이벤트를 한 줄씩 내보낸다.
YuE2 를 8GB VRAM 소비자용 그래픽카드에서 돌아가게 패치해서 실행한다.

명령
  {"cmd":"generate","jobId":str,"outDir":path,"style":str,"lyrics":str,
   "seed":int|null,"cot":"full"|"melody"|"off","id":str,"instrumental":bool}
  {"cmd":"cancel"} {"cmd":"ping"} {"cmd":"quit"}

이벤트
  {"type":"ready"|"stage"|"progress"|"notice"|"done"|"error"|"pong", ...}
"""
from __future__ import annotations

import dataclasses
import json
import os
import queue
import random
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
import torch

# YuE2 파이프라인은 CUDA 할당량을 (전체 - 2GiB) 로 묶어두고 그 위로는 OOM 을 낸다.
# 윈도우 드라이버가 시스템 RAM 으로 흘려보내는 길을 막아버리므로 상한을 푼다.
torch.cuda.set_per_process_memory_fraction = lambda *a, **k: None

import yue2.cuda_graph as cuda_graph  # noqa: E402
import yue2.nar as nar  # noqa: E402
from yue2 import YuE2Pipeline  # noqa: E402
from yue2.pipeline import SymbolicPlan, SemanticResult  # noqa: E402

# 빠른 모드는 CUDA 그래프를 쓴다. YuE2 기본값은 flash attention 인데 윈도우용
# PyTorch 에는 그 커널이 없다(함수는 있고 구현이 없다). 실제로 있는 백엔드를 박아둔다.
FAST_ATTENTION = os.environ.get("NORAE_ATTENTION", "cudnn")
_BaseGraphAR = cuda_graph.GraphAR


class GraphAR(_BaseGraphAR):
    def __init__(self, model, prefixes, max_tokens, *, capture=True,
                 attention_backend="auto", fuse_projections=False):
        if attention_backend == "auto":
            attention_backend = FAST_ATTENTION
        super().__init__(model, prefixes, max_tokens, capture=capture,
                         attention_backend=attention_backend,
                         fuse_projections=fuse_projections)


cuda_graph.GraphAR = GraphAR

_write_lock = threading.Lock()


def emit(**payload):
    with _write_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# ── 저VRAM 패치 ───────────────────────────────────────────────────────────────
_base_attention = nar.attention


def lowvram_attention(q, k, v, *, causal=False, backend="sdpa", query_chunk_size=None):
    """그룹 K/V 를 펼치고 쿼리를 타일로 나눈다.

    윈도우 PyTorch 에는 flash-attention 커널이 없고, memory-efficient 커널은
    grouped-query attention 을 거부한다. 그래서 기본 상태로는 math 커널로 떨어져
    한 번 호출에 ~4GiB 를 잡아먹는다. K/V 를 펼치면 빠른 커널을 계속 쓸 수 있고,
    타일링이 나머지 사용량의 상한을 잡아준다.
    """
    if q.device.type == "cuda" and q.shape[1] != k.shape[1]:
        groups = q.shape[1] // k.shape[1]
        k = k.repeat_interleave(groups, 1)
        v = v.repeat_interleave(groups, 1)
    return _base_attention(q, k, v, causal=causal, backend=backend,
                           query_chunk_size=query_chunk_size or 1024)


nar.attention = lowvram_attention


def ar_modules(model):
    """AR(자기회귀) 단계에서만 GPU 에 올리면 되는 모듈들."""
    mods = [model.model.embed_tokens, model.model.norm,
            model.model.rotary_emb, model.lm_head]
    for layer in model.model.layers:
        mods += [layer.input_layernorm, layer.self_attn,
                 layer.post_attention_layernorm, layer.mlp]
    return mods


class LowVramPipeline(YuE2Pipeline):
    """지금 단계에 필요한 가중치만 GPU 에 얹어 둔다."""

    def _load_model(self, for_nar=False):
        if self._model is None:
            from yue2.modeling_yue2 import YuE2ForCausalLM
            emit(type="stage", stage="load", status="start")
            self._model = YuE2ForCausalLM.from_pretrained(
                self.model_dir, local_files_only=True,
                dtype=torch.bfloat16, low_cpu_mem_usage=True).eval()
            emit(type="stage", stage="load", status="done")
        model = self._model
        mode = "nar" if for_nar else "ar"
        if getattr(model, "_norae_mode", None) != mode:
            model.to("cpu")
            torch.cuda.empty_cache()
            if for_nar:
                model.to(self.device)
            else:
                for module in ar_modules(model):
                    module.to(self.device)
            model._norae_mode = mode
            torch.cuda.empty_cache()
        return model

    def decode(self, *args, **kwargs):
        # 디코딩은 VAE 를 올리므로 다음 단계에서 배치를 다시 잡게 표시를 지운다.
        if self._model is not None:
            self._model._norae_mode = None
        return super().decode(*args, **kwargs)


# ── 연주곡(가사 없는 곡) ──────────────────────────────────────────────────────
NOTE = re.compile(r"[_^=]*[A-Ga-g][,']*")
CHORD_SYMBOL = re.compile(r'"[^"]*"')
NOTE_GROUP = re.compile(r"\[(?:[_^=]*[A-Ga-g][,']*\d*/?\d*)+\]")


def silence_vocals(abc: str) -> str:
    """ABC 악보의 Vocal 성부를 쉼표(z)로 바꾼다.

    프롬프트로 "instrumental" 이라고 부탁하는 건 권유일 뿐이다. 부를 음이 아예
    없는 악보를 주면 모델이 노래를 만들어낼 방법 자체가 없다.
    마디·길이·코드기호는 그대로 둬야 반주가 망가지지 않는다.
    """
    out, voice = [], None
    for line in abc.splitlines():
        header = re.match(r"V:\s*(\w+)", line)
        if header:
            voice = header.group(1)
            out.append(line)
            continue
        is_meta = not line or re.match(r"^[A-Za-z]:", line) or line.startswith("%")
        if voice != "Vocal" or is_meta:
            out.append(line)
            continue
        # 코드기호를 잠시 빼두고 음높이만 지운 뒤, 매달린 이음줄(-)을 정리한다.
        symbols = CHORD_SYMBOL.findall(line)
        body = CHORD_SYMBOL.sub("\0", line)
        body = NOTE_GROUP.sub("z", body)
        body = NOTE.sub("z", body)
        body = re.sub(r"(z[0-9/]*)-", r"\1", body)
        for symbol in symbols:
            body = body.replace("\0", symbol, 1)
        out.append(body)
    return "\n".join(out)


# ── 워커 ──────────────────────────────────────────────────────────────────────
class Worker:
    def __init__(self):
        self.pipe = None
        self.cancel = threading.Event()
        self.jobs = queue.Queue()
        # "torch" = AR 루프를 CUDA 그래프로 캡처(빠른 모드), "torch-eager" = 안전한 대체 경로.
        self.backend = "torch-eager" if os.environ.get("NORAE_FAST") == "0" else "torch"

    # 파이프라인 -------------------------------------------------------------
    def ensure_pipe(self):
        if self.pipe is None:
            self.pipe = LowVramPipeline.from_pretrained(
                "m-a-p/YuE2-3B", vae="m-a-p/YuE2-Vae", device="cuda",
                memory_budget_gib=8, offload_ar=True, backend=self.backend,
                local_files_only=True, progress=False)
        return self.pipe

    def downgrade(self, reason):
        """빠른 경로를 포기하고 eager 로 내려간다. 이미 받아둔 가중치는 그대로 쓴다."""
        emit(type="notice", message=f"빠른 모드를 끄고 기본 모드로 진행합니다 ({reason})")
        self.backend = "torch-eager"
        if self.pipe is not None:
            self.pipe.backend = "torch-eager"

    def cancelled(self):
        return self.cancel.is_set()

    # 생성 -------------------------------------------------------------------
    def generate(self, job):
        out = Path(job["outDir"])
        out.mkdir(parents=True, exist_ok=True)
        seed = job.get("seed")
        if seed is None:
            seed = random.randrange(2 ** 31)
        started = time.perf_counter()

        pipe = self.ensure_pipe()

        # 커버: 악보를 받아 오면 작곡 단계를 건너뛰고 그 악보를 그대로 쓴다.
        # 같은 멜로디·코드에 다른 편곡(스타일)이나 다른 가사를 입히는 길이다.
        abc = (job.get("abc") or "").strip() or None
        if abc and job.get("instrumental"):
            # 연주곡 커버는 받은 악보에서 바로 보컬을 지운다. 다시 계획할 필요가 없다.
            abc = silence_vocals(abc)

        request = pipe._request(style=job["style"], lyrics=job["lyrics"],
                                cot=job.get("cot", "full"), seed=int(seed),
                                abc=abc, id=job.get("id", "song"))

        counters = {"stage": None, "n": 0, "t0": time.perf_counter(), "last": 0.0}

        def on_token(_phase, _token):
            counters["n"] += 1
            now = time.perf_counter()
            if now - counters["last"] > 0.4:
                counters["last"] = now
                elapsed = max(now - counters["t0"], 1e-6)
                emit(type="progress", jobId=job["jobId"], stage=counters["stage"],
                     tokens=counters["n"], rate=round(counters["n"] / elapsed, 2))

        def start(stage):
            counters.update(stage=stage, n=0, t0=time.perf_counter(), last=0.0)
            emit(type="stage", jobId=job["jobId"], stage=stage, status="start")

        # 1단계 — 악보(심볼릭 플랜)
        plan_dir = out / "plan"
        if (plan_dir / "plan_manifest.json").exists():
            plan = SymbolicPlan.load(plan_dir)
        else:
            start("plan")
            plan = pipe.plan(request=request, cancelled=self.cancelled, on_token=on_token)
            # 악보를 직접 받은 경우(커버)에는 이미 위에서 보컬을 지웠다. 두 번 하지 않는다.
            if job.get("instrumental") and plan.abc and not abc:
                # 같은 악보에서 보컬 성부만 비우고 다시 계획한다.
                quiet = dataclasses.replace(request, abc=silence_vocals(plan.abc))
                plan = pipe.plan(request=quiet)
                request = quiet
            plan.save(plan_dir)
        emit(type="stage", jobId=job["jobId"], stage="plan", status="done",
             abc=plan.abc, truncated=plan.truncated)

        # 2단계 — 노래 토큰
        sem_file = out / "semantic.npy"
        if sem_file.exists():
            semantic = SemanticResult(plan, np.load(sem_file).tolist(), {}, False)
        else:
            start("semantic")
            semantic = pipe.generate_semantic(plan, cancelled=self.cancelled, on_token=on_token)
            np.save(sem_file, np.asarray(semantic.tokens, dtype=np.int32))
        emit(type="stage", jobId=job["jobId"], stage="semantic", status="done",
             tokens=len(semantic.tokens), truncated=semantic.truncated)

        # 3단계 — 음향 합성
        lat_file = out / "latent.npy"
        if lat_file.exists():
            latents = np.load(lat_file)
        else:
            start("synth")

            def on_steps(done, total):
                emit(type="progress", jobId=job["jobId"], stage="synth",
                     step=int(done), steps=int(total))

            # pipe.synthesize() 는 자체 콘솔 진행률이 켜져 있을 때만 단계를 알려준다.
            # 진행 막대를 채우려면 같은 루틴을 직접 불러야 한다.
            model = pipe._load_model(for_nar=True)
            latents = nar.synthesize(
                model, semantic.plan.prefix, semantic.tokens, request.seed,
                steps=pipe.generation_config.ode_steps,
                context=pipe.generation_config.context,
                offload_ar=True, cancelled=self.cancelled, on_progress=on_steps,
            ).detach().float().cpu().numpy()
            np.save(lat_file, latents)
        emit(type="stage", jobId=job["jobId"], stage="synth", status="done")

        # 4단계 — 오디오로 디코딩
        start("decode")
        audio = pipe.decode(latents)
        import soundfile as sf
        wav = out / "audio.wav"
        sf.write(wav, audio, 48000, subtype="PCM_24")
        emit(type="stage", jobId=job["jobId"], stage="decode", status="done")

        meta = {"id": request.id, "style": request.style, "lyrics": request.lyrics,
                "cot": request.cot, "seed": request.seed,
                "seconds": round(len(audio) / 48000, 1),
                "wallSeconds": round(time.perf_counter() - started, 1),
                "truncated": {"abc": plan.truncated, "semantic": semantic.truncated},
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
        # meta.json 은 앱 소유다(사용자가 붙인 제목이 들어 있다). 워커는 만든 것만 보고한다.
        (out / "result.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                                         encoding="utf-8")
        emit(type="done", jobId=job["jobId"], audio=str(wav), meta=meta)

    # 실행 루프 ---------------------------------------------------------------
    def run(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        emit(type="ready", cuda=torch.cuda.is_available(),
             gpu=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
        while True:
            job = self.jobs.get()
            if job is None:
                return
            self.cancel.clear()
            try:
                try:
                    self.generate(job)
                except (RuntimeError, NotImplementedError, ValueError) as exc:
                    # CUDA 그래프/어텐션 커널이 없다는 건 그래프를 캡처한 뒤에야 드러난다.
                    # 같은 작업을 eager 경로로 다시 돌린다. 끝난 단계는 디스크에 있으니
                    # 처음부터 다시 계산하지 않는다.
                    if self.backend != "torch" or self.cancel.is_set():
                        raise
                    self.downgrade(str(exc).splitlines()[0][:160])
                    torch.cuda.empty_cache()
                    self.generate(job)
            except InterruptedError:
                emit(type="error", jobId=job.get("jobId"), cancelled=True,
                     message="생성이 취소되었습니다.")
            except Exception as exc:  # noqa: BLE001
                import traceback
                emit(type="error", jobId=job.get("jobId"),
                     message=f"{type(exc).__name__}: {exc}",
                     detail=traceback.format_exc())
            finally:
                torch.cuda.empty_cache()

    def read_stdin(self):
        for line in sys.stdin:
            line = line.lstrip("\ufeff").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            cmd = message.get("cmd")
            if cmd == "generate":
                self.jobs.put(message)
            elif cmd == "cancel":
                self.cancel.set()
            elif cmd == "ping":
                emit(type="pong")
            elif cmd == "quit":
                self.jobs.put(None)
                return
        # stdin 이 닫혔다 = 앱이 사라졌다. 모델을 안고 메모리에 남아 있지 않는다.
        self.cancel.set()
        self.jobs.put(None)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    Worker().run()
