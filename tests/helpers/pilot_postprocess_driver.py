"""Cross-check driver: runs the bundle's reference tools/exposure_postprocess.py on one case and
prints its labels and decision support as JSON, so the TypeScript port can be compared with it.

Usage: python -E -s pilot_postprocess_driver.py <bundle tools dir>   (the case as JSON on stdin)
Case: {"state": {...}, "messages": [{turn, speaker, recipients, text}], "extractions": {"<turn>": {items: [...]}},
       "proposal_correct": bool}
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(sys.argv[1]))
from exposure_postprocess import decision_support, label_run  # noqa: E402
from settlement_task import metadata  # noqa: E402

case = json.load(sys.stdin)
state = case["state"]
extractions = {int(k): v for k, v in case["extractions"].items()}
labelled = label_run(state, case["messages"], extractions)
instance = {"state": state, "metadata": {"minimal_fact_sets": metadata(state)["minimal_fact_sets"]}}
support = decision_support(instance, labelled, case.get("proposal_correct", True))
json.dump({"labelled": labelled, "support": support}, sys.stdout, ensure_ascii=False, sort_keys=True)
