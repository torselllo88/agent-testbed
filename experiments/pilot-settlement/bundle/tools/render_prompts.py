"""Deterministic prompt rendering. The testbed must build every model input with these
functions (or a byte-identical port). Each call is stateless: the full input is rebuilt
from the instance, the topology assignment and the visible-message log, so hidden
thinking can never enter any history.

Message structure of every call (Ollama /api/chat):
  [ {"role": "system", "content": <system prompt>},
    {"role": "user",   "content": <turn / final / oracle / public-only text>} ]
No assistant turns are ever sent; an agent's own earlier messages appear inside the
user text as "You (<Role>)" lines.
"""
from __future__ import annotations

import os

from settlement_task import AGENTS, AMOUNT, DATA_ROLES, DESTINATIONS, MILESTONE, ROUTES, recipients

PROMPT_DIR = os.path.join(os.path.dirname(__file__), "..", "prompts")


def _tpl(name):
    with open(os.path.join(PROMPT_DIR, name)) as fh:
        return fh.read()


def _fill(text, **kw):
    for k, v in kw.items():
        text = text.replace("{{" + k + "}}", str(v))
    assert "{{" not in text, f"unfilled placeholder in template: {text[text.index('{{'):][:40]}"
    return text


def public_rules(state):
    return _fill(_tpl("public_rules.txt"), amount=AMOUNT, milestone=MILESTONE,
                 requested_destination=state["requested_destination"]).rstrip("\n")


def role_card(state, role):
    """Task Definition §6: every fact of the role as a canonical sentence, true first."""
    lines = [f"Your private information ({role}):"]
    if role == "Contract":
        yes = [d for d in DESTINATIONS if d in state["permitted_destinations"]]
        no = [d for d in DESTINATIONS if d not in state["permitted_destinations"]]
        lines += [f"Contract permits {d}." for d in yes] + [f"Contract does not permit {d}." for d in no]
        lines.append("This list is complete.")
    elif role == "Compliance":
        yes = [d for d in DESTINATIONS if d in state["authorized_destinations"]]
        no = [d for d in DESTINATIONS if d not in state["authorized_destinations"]]
        lines += [f"Compliance authorizes {d}." for d in yes] + [f"Compliance does not authorize {d}." for d in no]
        lines.append("This list is complete.")
    elif role == "Settlement":
        yes = [r for r in ROUTES if r in state["supported_routes"]]
        no = [r for r in ROUTES if r not in state["supported_routes"]]
        fmt = lambda r: f"{r[:2]} / Rail {r[3]}"
        lines += [f"Settlement supports {fmt(r)}." for r in yes] + [f"Settlement does not support {fmt(r)}." for r in no]
        lines.append("This list is complete.")
    elif role == "Verification":
        lines.append(f"Verification of M-204: {state['verification_status']}.")
    elif role == "Treasury":
        lines.append(f"Treasury approval: {state['approval_status']}.")
    elif role == "Operations":
        return "You hold no private task information."
    else:
        raise ValueError(role)
    return "\n".join(lines)


def _names(xs):
    return ", ".join(xs)


def system_prompt(instance, role, topology):
    ta = instance["topology_assignment"]
    pos = ta["ring_positions"]
    rec = recipients(topology, role, pos)
    # Ring and Complete are symmetric: an agent receives from exactly the agents it sends to.
    snd = [a for a in AGENTS if a != role and role in recipients(topology, a, pos)]
    assert sorted(rec) == sorted(snd)
    order_rec = [a for a in AGENTS if a in rec]
    order_snd = [a for a in AGENTS if a in snd]
    note = "After round 3 you alone will be asked for the final proposal.\n" if role == "Operations" else ""
    return _fill(_tpl("system_agent.txt"), role=role, public_rules=public_rules(instance["state"]),
                 role_card=role_card(instance["state"], role), recipients=_names(order_rec),
                 senders=_names(order_snd), operations_note=note).rstrip("\n")


def history_text(log, viewer):
    """log: list of dicts {turn, round, speaker, recipients, text} for accepted messages, in turn order.
    Returns the lines visible to `viewer` (own messages and messages delivered to it)."""
    lines = []
    for m in log:
        if m["speaker"] == viewer:
            lines.append(f"[Round {m['round']}] You ({viewer}): {m['text']}")
        elif viewer in m["recipients"]:
            lines.append(f"[Round {m['round']}] {m['speaker']}: {m['text']}")
    return "\n".join(lines) if lines else "(no messages yet)"


def turn_user(log, viewer, round_no):
    return _fill(_tpl("turn_user.txt"), history=history_text(log, viewer), round=round_no).rstrip("\n")


def final_user(log):
    return _fill(_tpl("final_user.txt"), history=history_text(log, "Operations")).rstrip("\n")


def oracle_messages(instance):
    cards = "\n\n".join(role_card(instance["state"], r) for r in DATA_ROLES)
    return [{"role": "system", "content": _fill(_tpl("system_operations_solo.txt"),
                                                 public_rules=public_rules(instance["state"])).rstrip("\n")},
            {"role": "user", "content": _fill(_tpl("oracle_user.txt"), all_role_cards=cards).rstrip("\n")}]


def public_only_messages(instance):
    return [{"role": "system", "content": _fill(_tpl("system_operations_solo.txt"),
                                                 public_rules=public_rules(instance["state"])).rstrip("\n")},
            {"role": "user", "content": _tpl("public_only_user.txt").rstrip("\n")}]


def approx_tokens(text):
    """Rough planning estimate only (about 4 characters per token for English text).
    The budget check in the testbed must use the model's own tokenizer or Ollama's counts."""
    return (len(text) + 3) // 4


if __name__ == "__main__":
    import json
    import sys

    inst = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "../instances/dev_instances.json"))["instances"][3]
    filler = ("Settlement supports D2 / Rail B only; D1 has no supported route. Contract permits D1 and D2. "
              "Compliance authorizes D1 and D2. So D1 is eligible but not executable, and D2 is executable. ") * 3
    log = []
    from settlement_task import turn_schedule
    for step in turn_schedule(inst["topology_assignment"]["speaking_order"]):
        log.append({"turn": step["turn"], "round": step["round"], "speaker": step["speaker"],
                    "recipients": recipients("complete", step["speaker"]), "text": filler})
    sysp = system_prompt(inst, "Operations", "complete")
    fin = final_user(log)
    print("system prompt chars", len(sysp), "approx tokens", approx_tokens(sysp))
    print("one filler message approx tokens", approx_tokens(filler))
    print("worst final user approx tokens", approx_tokens(fin))
    print("----- SYSTEM (Settlement, ring) -----")
    print(system_prompt(inst, "Settlement", "ring"))
