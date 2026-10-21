#!/usr/bin/env python3
"""dev-c7 measurement (WO-W23, GPU safety): an OFFLINE estimate of whether qwen3.8:27b at num_ctx 16384 fits entirely in the VRAM of Ollama Prime's GPU.

No Ollama call of any kind (no /api/show, /api/ps, load or warm-up): it reads only what earlier runs RECORDED (runs/dev-c6/devc6-qwen3.8-27b: the
/api/tags model metadata, the nvidia-smi snapshot taken before the load, and the per-turn native durations of the dev-c6 qwen run at num_ctx 8192).
The recorded metadata has no block, head or head-size counts, so the KV cache is computed under a STATED architecture assumption (family `qwen35`, the
Qwen3.5 hybrid layout) and again under a conservative bound that gives every block full-attention KV.  It is an estimate, never a measurement: the
decisive check is the runtime one (`--gpu-fit-check full-gpu-v1`: /api/ps after the warm-up must show size_vram == size, else unload and skip).

    python3 tools/media-repair-harness/scripts/devc7_gpu_fit.py [--out runs/dev-c7/gpu-fit-offline.json]
"""
import argparse
import glob
import json
import re
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE.parent / 'runs' / 'dev-c6' / 'devc6-qwen3.8-27b'
MIB = 1024 * 1024
NUM_CTX = 16384
# Architecture ASSUMPTION for GGUF family `qwen35` (the recorded `details.family`), the published Qwen3.5 hybrid layout, matching the recorded 27.3B
# parameters and embedding_length 5120: 64 blocks, full (gated) attention every 4th block, 4 KV heads of size 256; the other 48 blocks are Gated DeltaNet
# with a fixed-size state (48 value heads, key and value head size 128, convolution kernel 4).  None of these counts is in the recorded metadata.
ASSUMED = {'blocks': 64, 'attention_blocks': 16, 'kv_heads': 4, 'head_dim': 256, 'linear_blocks': 48, 'linear_v_heads': 48, 'linear_k_heads': 16,
           'linear_head_dim': 128, 'conv_kernel': 4, 'kv_bytes': 2, 'state_bytes': 4,
           'source': 'assumption: the published Qwen3.5 (GGUF family qwen35) hybrid layout; not in the recorded /api/tags metadata'}
SERVER = {'kv_cache_type': 'f16 (OLLAMA_KV_CACHE_TYPE unset in the ollama-prime HelmRelease)', 'parallel_slots': 1,
          'parallel_note': 'OLLAMA_NUM_PARALLEL unset in the HelmRelease; one slot assumed (a second slot would double the KV cache)'}
# Allowances that cannot be derived offline (stated, generous, not measured): the compute graph at num_ctx 16384 and the CUDA context.
COMPUTE_ALLOWANCE_MIB = 1536
CUDA_CONTEXT_ALLOWANCE_MIB = 512


def kv_bytes(blocks, kv_heads, head_dim, ctx, nbytes=2):
    return blocks * 2 * kv_heads * head_dim * nbytes * ctx


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    args = ap.parse_args(argv)
    man = json.loads((RUN / 'manifest.json').read_text())
    info = man['preflight']['model_info']
    smi = man['preflight']['resources_before']['stdout']
    m = re.search(r'GPU-[0-9a-f-]+, (\d+) MiB, (\d+) MiB', smi)
    used_mib, free_mib = int(m.group(1)), int(m.group(2))
    gen, pe = [], []
    for p in sorted(glob.glob(str(RUN / '*-*-[0-9]*.json'))):
        for t in json.loads(Path(p).read_text())['turns']:
            n = t.get('native') or {}
            if n.get('eval_duration'):
                gen.append(n['eval_count'] / (n['eval_duration'] / 1e9))
            if n.get('prompt_eval_duration'):
                pe.append(n['prompt_eval_count'] / (n['prompt_eval_duration'] / 1e9))
    weights = info['size']
    a = ASSUMED
    kv_assumed = kv_bytes(a['attention_blocks'], a['kv_heads'], a['head_dim'], NUM_CTX, a['kv_bytes'])
    kv_bound = kv_bytes(a['blocks'], a['kv_heads'], a['head_dim'], NUM_CTX, a['kv_bytes'])
    conv_channels = 2 * a['linear_k_heads'] * a['linear_head_dim'] + a['linear_v_heads'] * a['linear_head_dim']
    state = a['linear_blocks'] * (a['linear_v_heads'] * a['linear_head_dim'] * a['linear_head_dim'] + (a['conv_kernel'] - 1) * conv_channels) * a['state_bytes']
    allow = (COMPUTE_ALLOWANCE_MIB + CUDA_CONTEXT_ALLOWANCE_MIB) * MIB

    def total(kv):
        t = weights + kv + state + allow
        return {'total_mib': round(t / MIB), 'headroom_mib': round(free_mib - t / MIB), 'fits': t / MIB < free_mib}
    out = {
        'note': 'OFFLINE ESTIMATE from recorded metadata only; no Ollama call; the runtime check full-gpu-v1 (size_vram == size at warm-up) is decisive',
        'recorded': {'source': 'runs/dev-c6/devc6-qwen3.8-27b/manifest.json (preflight) and its 107 turn records',
                     'model': man['requested_model'], 'digest': man['model_digest'], 'runtime_version': man['runtime_version'],
                     'details': info['details'], 'size_bytes': weights, 'size_mib': round(weights / MIB, 1),
                     'gpu_memory_used_mib_before_load': used_mib, 'gpu_memory_free_mib_before_load': free_mib,
                     'devc6_num_ctx': man['config']['adapter_config']['options']['num_ctx'],
                     'devc6_generation_tokens_per_s': {'n': len(gen), 'median': round(statistics.median(gen), 1), 'min': round(min(gen), 1)},
                     'devc6_prompt_eval_tokens_per_s': {'median': round(statistics.median(pe)), 'min': round(min(pe))}},
        'architecture': ASSUMED, 'server': SERVER, 'num_ctx': NUM_CTX,
        'components_mib': {'weights_blob': round(weights / MIB), 'kv_cache_assumed_layout': round(kv_assumed / MIB),
                           'kv_cache_bound_every_block_attention': round(kv_bound / MIB), 'linear_attention_state': round(state / MIB, 1),
                           'compute_graph_allowance': COMPUTE_ALLOWANCE_MIB, 'cuda_context_allowance': CUDA_CONTEXT_ALLOWANCE_MIB},
        'increment_over_devc6_8192_mib': {'kv_assumed_layout': round((kv_assumed - kv_bytes(a['attention_blocks'], a['kv_heads'], a['head_dim'], 8192)) / MIB),
                                          'kv_bound': round((kv_bound - kv_bytes(a['blocks'], a['kv_heads'], a['head_dim'], 8192)) / MIB)},
        'estimate': {'assumed_layout': total(kv_assumed), 'conservative_bound': total(kv_bound)},
        'reading': ('the dev-c6 qwen run at num_ctx 8192 generated at %.1f tokens/s median (min %.1f) over %d turns, a rate that reads every weight from VRAM '
                    'for each token; a split with CPU layers would be bounded by host-memory bandwidth for its share. An inference that 8192 ran fully on the '
                    'GPU, not a measurement (dev-c6 recorded no /api/ps after its load).' % (statistics.median(gen), min(gen), len(gen))),
        'limits': ['block, head and head-size counts are assumed (not recorded); a different layout changes the KV cache',
                   'compute-graph and CUDA-context sizes are allowances, not derived; flash attention and the server\'s own memory estimate are not known offline',
                   'Ollama decides the GPU/CPU split itself at load time; only /api/ps after the warm-up shows it'],
    }
    text = json.dumps(out, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
