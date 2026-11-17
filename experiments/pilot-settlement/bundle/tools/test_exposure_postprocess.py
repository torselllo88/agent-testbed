"""Unit tests for exposure_postprocess.py built from the examples in
Exposure & Instance Metadata v1.4 (E3, E4, E5) and plan section 9.
Run: python3 -m pytest -q test_exposure_postprocess.py   (or: python3 test_exposure_postprocess.py)"""
from exposure_postprocess import claims_from_extraction, decision_support, label_run
from sample_instances import DEV_STATES, build_record
from settlement_task import metadata

A1 = [s for i, td, s in DEV_STATES if td == "A1"][0]   # requested D2; Contract D1,D2; Compliance D1,D2; D1/B, D2/A


def fact(span, *, role=None, pred=None, pol="positive", objs=(), exhaustive=False, scope=None, status=None, hedged=False, first=False):
    return {"span": span, "kind": "fact", "hedged": hedged, "role_named": role, "first_person": first,
            "relay_marker": False, "predicate": pred, "polarity": pol, "objects": list(objs),
            "exhaustive": exhaustive, "scope_destination": scope, "status_value": status, "derived": None, "proposal": None}


def dest(d):
    return {"type": "destination", "destination": d, "rail": None}


def route(d, r):
    return {"type": "route", "destination": d, "rail": r}


def base_set(claims):
    return {(c["fact"], c["value"]) for c in claims if c["type"] == "base"}


def test_e4_exhaustive_contract():
    c = claims_from_extraction({"items": [fact("Contract permits D1 only.", role="Contract", pred="permits",
                                                objs=[dest("D1")], exhaustive=True)]}, "Contract")
    assert base_set(c) == {("contract.permits.D1", True), ("contract.permits.D2", False)}


def test_e4_non_exhaustive():
    c = claims_from_extraction({"items": [fact("Contract permits D1.", role="Contract", pred="permits", objs=[dest("D1")])]}, "Settlement")
    assert base_set(c) == {("contract.permits.D1", True)}


def test_e4_no_rail_for_destination():
    c = claims_from_extraction({"items": [fact("Settlement supports no rail for D1.", role="Settlement", pred="supports",
                                                pol="negative", objs=[dest("D1")])]}, "Settlement")
    assert base_set(c) == {("settlement.supports.D1.A", False), ("settlement.supports.D1.B", False)}


def test_e4_only_one_route():
    c = claims_from_extraction({"items": [fact("Settlement supports only D2 / Rail B.", role="Settlement", pred="supports",
                                                objs=[route("D2", "B")], exhaustive=True)]}, "Settlement")
    assert base_set(c) == {("settlement.supports.D2.B", True), ("settlement.supports.D1.A", False),
                           ("settlement.supports.D1.B", False), ("settlement.supports.D2.A", False)}


def test_e4_scope_destination():
    c = claims_from_extraction({"items": [fact("For D1, Settlement supports only Rail B.", role="Settlement", pred="supports",
                                                objs=[route("D1", "B")], exhaustive=True, scope="D1")]}, "Settlement")
    assert base_set(c) == {("settlement.supports.D1.A", False), ("settlement.supports.D1.B", True)}


def test_e4_bare_destination_is_derived():
    c = claims_from_extraction({"items": [fact("Settlement supports D1.", role="Settlement", pred="supports", objs=[dest("D1")])]}, "Settlement")
    assert [x for x in c if x["type"] == "derived"][0]["item"] == "has_route"
    assert base_set(c) == set()


def test_e3_sender_own_fact():
    c = claims_from_extraction({"items": [fact("D2 is allowed.", pred="allowed", objs=[dest("D2")])]}, "Contract")
    assert base_set(c) == {("contract.permits.D2", True)}


def test_e3_unattributed_non_source_sender():
    c = claims_from_extraction({"items": [fact("D2 is not allowed.", pred="allowed", pol="negative", objs=[dest("D2")])]}, "Treasury")
    assert c[0]["type"] == "unattributed"


def test_e3_wrong_object_type():
    c = claims_from_extraction({"items": [fact("D1 is approved.", pred="approved", objs=[dest("D1")])]}, "Settlement")
    assert c[0]["type"] == "unattributed"


def test_e3_other_roles_reserved_word():
    c = claims_from_extraction({"items": [fact("D2 is authorized.", pred="authorized", objs=[dest("D2")])]}, "Contract")
    assert base_set(c) == {("compliance.authorizes.D2", True)}


def test_e3_pending_alone():
    c = claims_from_extraction({"items": [fact("It is pending.", pred="pending", status="pending")]}, "Settlement")
    assert c[0]["type"] == "unattributed"


def msg(turn, speaker, recipients):
    return {"turn": turn, "speaker": speaker, "recipients": recipients, "text": "..."}


def test_e5_lucky_guess_and_relay():
    msgs = [msg(1, "Compliance", ["Settlement"]), msg(2, "Settlement", ["Operations"])]
    guess = fact("Contract permits D1.", role="Contract", pred="permits", objs=[dest("D1")])
    lab = label_run(A1, msgs, {1: {"items": [guess]}, 2: {"items": [guess]}})
    c1, c2 = [c for c in lab if c["type"] == "base"]
    assert (c1["source"], c1["support"], c1["truth"]) == ("unsourced", "unsupported", True)
    assert (c2["source"], c2["grounding"], c2["support"]) == ("relayed", "grounded", "unsupported")


def test_e5_own_and_supported_relay():
    msgs = [msg(1, "Contract", ["Settlement"]), msg(2, "Settlement", ["Operations"])]
    own = fact("Contract permits D1.", role="Contract", pred="permits", objs=[dest("D1")])
    lab = label_run(A1, msgs, {1: {"items": [own]}, 2: {"items": [own]}})
    c1, c2 = [c for c in lab if c["type"] == "base"]
    assert (c1["source"], c1["support"]) == ("own", "supported")
    assert (c2["source"], c2["support"]) == ("relayed", "supported")


def test_e5_grounded_derived():
    # Contract with {D1} alone grounds eligible(D2) = false, not eligible(D1) = true (E5 example).
    s = dict(A1, permitted_destinations=["D1"])
    msgs = [msg(1, "Contract", ["Operations"])]
    items = [{"span": "D2 is not eligible.", "kind": "derived", "hedged": False,
              "derived": {"item": "eligible", "destination": "D2", "set_value": None, "value": False}},
             {"span": "D1 is eligible.", "kind": "derived", "hedged": False,
              "derived": {"item": "eligible", "destination": "D1", "set_value": None, "value": True}}]
    lab = label_run(s, msgs, {1: {"items": items}})
    assert [c["grounding"] for c in lab] == ["grounded", "ungrounded"]


def test_decision_support_categories():
    inst = build_record("T-1", "dev", A1)
    full = [fact("Contract permits D2.", role="Contract", pred="permits", objs=[dest("D2")]),
            fact("Compliance authorizes D2.", role="Compliance", pred="authorizes", objs=[dest("D2")]),
            fact("Settlement supports D2 / Rail A.", role="Settlement", pred="supports", objs=[route("D2", "A")]),
            fact("Verification of M-204: accepted.", role="Verification", pred="accepted", status="accepted",
                 objs=[{"type": "milestone", "destination": None, "rail": None}]),
            fact("Treasury approval: approved.", role="Treasury", pred="approved", status="approved",
                 objs=[{"type": "approval", "destination": None, "rail": None}])]
    speakers = ["Contract", "Compliance", "Settlement", "Verification", "Treasury"]
    msgs = [msg(i + 1, sp, ["Operations"]) for i, sp in enumerate(speakers)]
    lab = label_run(A1, msgs, {i + 1: {"items": [full[i]]} for i in range(5)})
    assert decision_support(inst, lab, True)["category"] == "base_sufficient"
    lab3 = label_run(A1, msgs[:3], {i + 1: {"items": [full[i]]} for i in range(3)})
    assert decision_support(inst, lab3, True)["category"] == "status_default_sufficient"
    assert decision_support(inst, [], True)["category"] == "insufficient"


if __name__ == "__main__":
    import sys
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok  ", name)
            except AssertionError as e:
                fails += 1
                print("FAIL", name, e)
    sys.exit(1 if fails else 0)
