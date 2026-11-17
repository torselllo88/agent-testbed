"""Deterministic per-call seed schedule (plan section 3.3).

Discussion, final and oracle calls:
    seed = first 31 bits of sha256("master|instance|call_type|round|speaker|replicate")
Topology is deliberately NOT part of the key: the Complete and Ring calls of the same
instance, round and speaker get the same seed, which keeps the pairing, while different
agents and turns never share a random stream.

Public-only calls:
    seed = first 31 bits of sha256("master|public_only|sha256(system + user)|replicate")
The key depends only on the public prompt, so two instances with the same requested
destination get the same seed. With reproducible sampling (gate G6) the public-only
policy is then a deterministic function of the public input per replicate, and the
public-policy ceilings of gate G4 are strict bounds rather than bounds on an expectation.

Retries after a transport/runtime error reuse the call's seed. Over-length regeneration
reuses it too (its input differs by the appended reminder). Model failures are never
retried inside the primary run (plan section 11).
"""
from __future__ import annotations

import hashlib
import json

MASTER_SEED = 20261120


def _seed(key: str) -> int:
    return int.from_bytes(hashlib.sha256(key.encode()).digest()[:4], "big") & 0x7FFFFFFF


def messages_sha256(messages: list[dict]) -> str:
    """Hash of the exact [system, user] input of a call."""
    blob = json.dumps([[m["role"], m["content"]] for m in messages], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def call_seed(instance_id: str, call_type: str, round_no: int | None = None, speaker: str | None = None,
              replicate: int = 0, master_seed: int = MASTER_SEED) -> int:
    if call_type not in ("discussion", "final", "oracle"):
        raise ValueError(f"{call_type}: use public_only_seed for public-only calls")
    return _seed(f"{master_seed}|{instance_id}|{call_type}|{'' if round_no is None else round_no}|{speaker or ''}|{replicate}")


def public_only_seed(messages: list[dict], replicate: int = 0, master_seed: int = MASTER_SEED) -> int:
    return _seed(f"{master_seed}|public_only|{messages_sha256(messages)}|{replicate}")


def run_seed_table(instance_id: str, speaking_order: list[str], k_rounds: int = 3) -> list[dict]:
    """All seeds of one discussion run, in call order (identical for Complete and Ring)."""
    rows = []
    for r in range(1, k_rounds + 1):
        for a in speaking_order:
            rows.append({"call_type": "discussion", "round": r, "speaker": a,
                         "seed": call_seed(instance_id, "discussion", r, a)})
    rows.append({"call_type": "final", "round": None, "speaker": "Operations",
                 "seed": call_seed(instance_id, "final", None, "Operations")})
    return rows


if __name__ == "__main__":
    import sys
    t = run_seed_table(sys.argv[1] if len(sys.argv) > 1 else "P-01",
                       ["Operations", "Contract", "Compliance", "Settlement", "Verification", "Treasury"])
    assert len({r["seed"] for r in t}) == len(t), "seed collision inside a run"
    print(json.dumps(t, indent=1))
