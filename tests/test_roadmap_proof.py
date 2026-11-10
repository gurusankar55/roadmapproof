"""Unit tests for the RoadmapProof v2 Intelligent Contract.

Runs with plain Python (no GenLayer node needed):

    python tests/test_roadmap_proof.py

A small stand-in for the `genlayer` module is installed first, so the real
contract file is loaded and every rule is checked: ownership, duplicates,
VOID for already-shipped items, KEPT / BROKEN / PENDING and Trust Scores.
The web page and the AI judge are replaced by fixed answers per test.
"""

import importlib.util
import json
import os
import sys
import types
import unittest
from datetime import datetime as _real_datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_PATH = os.path.join(HERE, "..", "contracts", "roadmap_proof.py")


# ----------------------------------------------------------- genlayer stand-in
class TreeMap(dict):
    pass


class DynArray(list):
    pass


class _Addr:
    def __init__(self, hex_):
        self.as_hex = hex_


class _Contract:
    def __new__(cls, *a, **kw):
        obj = super().__new__(cls)
        for name, tp in getattr(cls, "__annotations__", {}).items():
            origin = getattr(tp, "__origin__", tp)
            if origin is TreeMap:
                setattr(obj, name, TreeMap())
            elif origin is DynArray:
                setattr(obj, name, DynArray())
        return obj


def _identity(fn):
    return fn


class _Judge:
    page = ""
    answer = '{"verdict": "UNCLEAR", "reason": "not set"}'
    last_prompt = ""


def _render(url, mode="text"):
    return _Judge.page


def _exec_prompt(prompt):
    _Judge.last_prompt = prompt
    return _Judge.answer


gl = types.SimpleNamespace(
    Contract=_Contract,
    public=types.SimpleNamespace(write=_identity, view=_identity),
    message=types.SimpleNamespace(sender_address=_Addr("0x" + "a" * 40)),
    nondet=types.SimpleNamespace(
        web=types.SimpleNamespace(render=_render), exec_prompt=_exec_prompt
    ),
    eq_principle=types.SimpleNamespace(prompt_comparative=lambda fn, principle: fn()),
)

mock = types.ModuleType("genlayer")
mock.gl = gl
mock.TreeMap = TreeMap
mock.DynArray = DynArray
mock.u256 = int
mock.__all__ = ["gl", "TreeMap", "DynArray", "u256"]
sys.modules["genlayer"] = mock

spec = importlib.util.spec_from_file_location("roadmap_proof", CONTRACT_PATH)
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)


class FakeDatetime(_real_datetime):
    current = _real_datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        c = cls.current
        return cls(c.year, c.month, c.day, c.hour, c.minute, tzinfo=c.tzinfo)


rp.datetime = FakeDatetime

TEAM = "0x" + "a" * 40
OTHER = "0x" + "b" * 40


def as_wallet(addr):
    gl.message.sender_address = _Addr(addr)


def set_today(y, m, d):
    FakeDatetime.current = _real_datetime(y, m, d, 12, 0, tzinfo=timezone.utc)


def judge_says(verdict, reason="test reason"):
    _Judge.answer = json.dumps({"verdict": verdict, "reason": reason})


# ------------------------------------------------------------------- the tests
class RoadmapProofTests(unittest.TestCase):
    def setUp(self):
        set_today(2026, 11, 10)
        as_wallet(TEAM)
        self.c = rp.RoadmapProof()
        self.c.__init__()

    def make(self, project="Nebula DEX", claim="Release v2.0 with limit orders",
             url="https://github.com/nebula/dex/releases", deadline="2026-12-15"):
        self.c.create_promise(project, claim, url, deadline)
        return str(int(self.c.counter))

    def promise(self, pid):
        return json.loads(self.c.get_promise(pid))

    # --- fix 1: ownership --------------------------------------------------
    def test_first_wallet_becomes_owner(self):
        self.make()
        proj = json.loads(self.c.get_project("nebula dex"))
        self.assertEqual(proj["owner"], TEAM)

    def test_other_wallet_cannot_post_for_owned_project(self):
        self.make()
        as_wallet(OTHER)
        with self.assertRaisesRegex(Exception, "Only the project owner"):
            self.make(claim="Launch the mobile app on iOS")

    def test_name_variants_map_to_same_owner(self):
        self.make(project="Nebula DEX")
        as_wallet(OTHER)
        with self.assertRaisesRegex(Exception, "Only the project owner"):
            self.make(project="  nebula-dex ", claim="Launch the mobile app on iOS")

    def test_claim_project_and_reject_second_claim(self):
        self.c.claim_project("Orbit Wallet", "https://orbit.example")
        as_wallet(OTHER)
        with self.assertRaisesRegex(Exception, "already claimed"):
            self.c.claim_project("orbit wallet", "")

    def test_transfer_project(self):
        self.make()
        self.c.transfer_project("Nebula DEX", OTHER.upper().replace("0X", "0x"))
        as_wallet(OTHER)
        self.make(claim="Launch the mobile app on iOS")
        self.assertEqual(json.loads(self.c.get_project("Nebula DEX"))["owner"], OTHER)

    def test_only_owner_can_transfer(self):
        self.make()
        as_wallet(OTHER)
        with self.assertRaisesRegex(Exception, "Only the project owner"):
            self.c.transfer_project("Nebula DEX", OTHER)

    # --- fix 3: duplicates -------------------------------------------------
    def test_duplicate_promise_rejected(self):
        self.make(claim="Release Python 3.14")
        with self.assertRaisesRegex(Exception, "already recorded as #1"):
            self.make(claim="  release python 3.14! ")

    # --- input rules -------------------------------------------------------
    def test_past_deadline_rejected(self):
        with self.assertRaisesRegex(Exception, "past"):
            self.make(deadline="2026-11-09")

    def test_http_url_rejected(self):
        with self.assertRaisesRegex(Exception, "https"):
            self.make(url="http://example.com")

    # --- fix 2: verdicts ---------------------------------------------------
    def test_created_date_is_sent_to_judge(self):
        pid = self.make()
        judge_says("NOT_DELIVERED")
        self.c.verify_promise(pid)
        self.assertIn("PROMISE MADE ON: 2026-11-10", _Judge.last_prompt)

    def test_already_shipped_becomes_void_not_kept(self):
        pid = self.make(claim="Release Python 3.14")
        judge_says("ALREADY_DONE", "Python 3.14 shipped Oct 2025")
        self.c.verify_promise(pid)
        self.assertEqual(self.promise(pid)["status"], "VOID")
        board = json.loads(self.c.get_leaderboard())
        self.assertEqual(board[0]["score"], -1)   # VOID gives no score
        self.assertEqual(board[0]["void"], 1)

    def test_delivered_becomes_kept(self):
        pid = self.make()
        judge_says("DELIVERED")
        self.c.verify_promise(pid)
        self.assertEqual(self.promise(pid)["status"], "KEPT")

    def test_not_delivered_before_deadline_stays_pending(self):
        pid = self.make()
        judge_says("NOT_DELIVERED")
        self.c.verify_promise(pid)
        p = self.promise(pid)
        self.assertEqual(p["status"], "PENDING")
        self.assertTrue(p["reason"].startswith("Deadline still open"))

    def test_not_delivered_after_deadline_becomes_broken(self):
        pid = self.make(deadline="2026-11-10")
        set_today(2026, 11, 11)
        judge_says("NOT_DELIVERED")
        self.c.verify_promise(pid)
        self.assertEqual(self.promise(pid)["status"], "BROKEN")

    def test_unclear_never_resolves(self):
        pid = self.make(deadline="2026-11-10")
        set_today(2026, 11, 20)
        judge_says("UNCLEAR")
        self.c.verify_promise(pid)
        self.assertEqual(self.promise(pid)["status"], "PENDING")

    def test_bad_model_output_is_unclear(self):
        pid = self.make()
        _Judge.answer = "I think it shipped"
        self.c.verify_promise(pid)
        self.assertEqual(self.promise(pid)["status"], "PENDING")

    def test_resolved_promise_cannot_be_verified_again(self):
        pid = self.make()
        judge_says("DELIVERED")
        self.c.verify_promise(pid)
        with self.assertRaisesRegex(Exception, "already resolved"):
            self.c.verify_promise(pid)

    # --- trust score -------------------------------------------------------
    def test_trust_score(self):
        a = self.make(claim="Release v2.0 with limit orders", deadline="2026-11-10")
        b = self.make(claim="Launch the mobile app on iOS", deadline="2026-11-10")
        set_today(2026, 11, 11)
        judge_says("DELIVERED")
        self.c.verify_promise(a)
        judge_says("NOT_DELIVERED")
        self.c.verify_promise(b)
        row = json.loads(self.c.get_leaderboard())[0]
        self.assertEqual((row["kept"], row["broken"], row["score"]), (1, 1, 50))
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats["total_checks"], 2)
        self.assertEqual(stats["version"], "2.0.0")

    def test_version(self):
        self.assertEqual(self.c.get_version(), "2.0.0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
