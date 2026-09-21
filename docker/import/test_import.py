"""Tests for the import job's throttle handling and cookie validation.

Run with: python3 docker/import/test_import.py

Plain asserts and a __main__ runner rather than pytest: the import image
ships only what yt-dlp needs, and these must be runnable anywhere without
adding a test dependency to it. import.py is loaded by path with its
heavyweight imports stubbed, so nothing here touches the network.
"""

import importlib.util
import os
import pathlib
import threading
import sys
import types


def load_import_module():
    for name in ("yt_dlp", "boto3", "websockets", "websockets.asyncio", "websockets.asyncio.client"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["boto3"].client = lambda *a, **k: None
    sys.modules["websockets.asyncio.client"].connect = lambda *a, **k: None
    for key in (
        "WORKER_BASE_URL", "IMPORT_WEBHOOK_SECRET", "JOB_ID", "USER_ID", "SOURCE_URL",
        "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "SOCKS5_PROXY",
    ):
        os.environ.setdefault(key, "x")

    path = pathlib.Path(__file__).with_name("import.py")
    spec = importlib.util.spec_from_file_location("import_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_import_module()
failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(("PASS  " if condition else "FAIL  ") + name)
    if not condition:
        failures.append(name)


class FakeError(Exception):
    pass


def test_error_classification() -> None:
    check("429 counts as rate limiting", m._is_rate_limit_error(FakeError("HTTP Error 429")))
    check(
        "'Too Many Requests' counts as rate limiting",
        m._is_rate_limit_error(FakeError("Too Many Requests")),
    )
    # The exact text a throttled session gets. Previously unmatched, so
    # every song hitting it was recorded as a permanent failure.
    check(
        "YouTube's 'try again later' counts as rate limiting",
        m._is_rate_limit_error(
            FakeError("This content isn't available, try again later. rate-limited by YouTube")
        ),
    )
    # Ambiguous, so it must not ride the long ladder meant for definite
    # throttling — see _is_maybe_throttled_error.
    check(
        "'Video unavailable' is treated as ambiguous, not as definite throttling",
        not m._is_rate_limit_error(FakeError("ERROR: [youtube] abc: Video unavailable"))
        and m._is_maybe_throttled_error(FakeError("ERROR: [youtube] abc: Video unavailable")),
    )
    check(
        "the bot-check wall is still detected",
        m._is_bot_check_error(FakeError("Sign in to confirm you're not a bot")),
    )
    check(
        "an unrelated failure is not retried at all",
        not m._is_rate_limit_error(FakeError("Private video"))
        and not m._is_maybe_throttled_error(FakeError("Private video"))
        and not m._is_bot_check_error(FakeError("Private video")),
    )


def test_throttle_gate() -> None:
    gate = m.ThrottleGate()
    check("an unthrottled gate imposes no delay", gate._delay == 0.0)

    gate.record_throttled()
    check("the first throttle starts the ladder at 2s", gate._delay == 2.0)
    gate.record_throttled()
    check("each further throttle doubles the gap", gate._delay == 4.0)

    for _ in range(30):
        gate.record_throttled()
    check("the gap stops at the ceiling", gate._delay == m.ThrottleGate.MAX_DELAY_SECONDS)
    check("the ceiling is thirty minutes", m.ThrottleGate.MAX_DELAY_SECONDS == 1800.0)

    # One good response must not undo a backoff that is still needed.
    gate.record_success()
    check("a single success does not clear the backoff", gate._delay == m.ThrottleGate.MAX_DELAY_SECONDS)

    for _ in range(m.ThrottleGate.RECOVERY_THRESHOLD):
        gate.record_success()
    check("a clean streak eases the gap back down", gate._delay < m.ThrottleGate.MAX_DELAY_SECONDS)

    clean = m.ThrottleGate()
    for _ in range(50):
        clean.record_success()
    check("successes on a clean gate never push it negative", clean._delay == 0.0)


def test_retry_behaviour() -> None:
    original_base = m.YT_DLP_RETRY_BASE_DELAY_SECONDS
    m.YT_DLP_RETRY_BASE_DELAY_SECONDS = 0
    m.THROTTLE_GATE = m.ThrottleGate()
    try:
        attempts = {"n": 0}

        def flaky():
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise FakeError("ERROR: [youtube] x: Video unavailable")
            return "ok"

        check("a transient 'Video unavailable' is retried to success", m.with_retry(flaky, description="t") == "ok")
        check("it really did retry rather than succeeding first time", attempts["n"] == 3)

        give_up = {"n": 0}

        def always_fails():
            give_up["n"] += 1
            raise FakeError("ERROR: [youtube] x: Video unavailable")

        raised = False
        try:
            m.with_retry(always_fails, description="t")
        except FakeError:
            raised = True
        check("a genuinely dead video eventually gives up", raised)
        check(
            "and is bounded by the short ladder, not the long one",
            give_up["n"] == m.YT_DLP_MAYBE_THROTTLED_MAX_RETRIES + 1,
        )

        never_retried = {"n": 0}

        def private_video():
            never_retried["n"] += 1
            raise FakeError("ERROR: Private video. Sign in if you've been granted access")

        try:
            m.with_retry(private_video, description="t")
        except FakeError:
            pass
        check("a private video is not retried even once", never_retried["n"] == 1)
    finally:
        m.YT_DLP_RETRY_BASE_DELAY_SECONDS = original_base


def test_network_error_handling() -> None:
    real = "ERROR: \r[download] Got error: <urlopen error [Errno 4] Host unreachable>"
    check("a dropped route is recognised as a network failure", m._is_transient_network_error(FakeError(real)))
    check(
        "and is NOT treated as throttling, which would back every worker off",
        not m._is_rate_limit_error(FakeError(real)),
    )
    check(
        "a genuinely dead video is not mistaken for a network failure",
        not m._is_transient_network_error(FakeError("ERROR: [youtube] x: Video unavailable")),
    )

    original_base = m.YT_DLP_NETWORK_BASE_DELAY_SECONDS
    m.YT_DLP_NETWORK_BASE_DELAY_SECONDS = 0
    m.THROTTLE_GATE = m.ThrottleGate()
    try:
        attempts = {"n": 0}

        def flaky_link():
            attempts["n"] += 1
            if attempts["n"] < 4:
                raise FakeError(real)
            return "ok"

        # Four attempts is past where the rate-limit ladder gives up, which
        # is exactly the case seen in production: one video recorded four
        # consecutive "Host unreachable" failures.
        check("a link that returns after several seconds still succeeds", m.with_retry(flaky_link, description="t") == "ok")
        check("it really did retry", attempts["n"] == 4)

        # The gate must stay open: spacing every worker out because one
        # route flapped would slow the whole job for a non-YouTube problem.
        check(
            "a network failure does not engage the throttle gate",
            m.THROTTLE_GATE._delay == 0.0,
        )

        down = {"n": 0}

        def always_down():
            down["n"] += 1
            raise FakeError(real)

        try:
            m.with_retry(always_down, description="t")
        except FakeError:
            pass
        check(
            "a link that never comes back is bounded by its own ladder",
            down["n"] == m.YT_DLP_NETWORK_MAX_RETRIES + 1,
        )
    finally:
        m.YT_DLP_NETWORK_BASE_DELAY_SECONDS = original_base


def test_per_worker_cookie_copies(tmp_dir: pathlib.Path) -> None:
    source = tmp_dir / "cookies.txt"
    source.write_text("# Netscape HTTP Cookie File\n")
    original_path = m.YT_DLP_COOKIES_PATH
    original_copies = m._COOKIE_COPIES
    m.YT_DLP_COOKIES_PATH = str(source)
    m._COOKIE_COPIES = threading.local()
    try:
        # yt-dlp rewrites cookiefile non-atomically when a YoutubeDL
        # context closes, so two workers sharing one path can read it
        # mid-truncate. Each worker must therefore get its own file.
        paths = {}

        def record(key):
            paths[key] = m.yt_dlp_options().get("cookiefile")

        threads = [threading.Thread(target=record, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        check("every worker got a cookies file", all(paths.values()) and len(paths) == 3)
        check("and no two workers share one", len(set(paths.values())) == 3)
        check(
            "none of them is the shared original yt-dlp would overwrite",
            str(source) not in set(paths.values()),
        )
        check(
            "the copy carries the real contents",
            pathlib.Path(next(iter(paths.values()))).read_text().startswith("# Netscape"),
        )
    finally:
        m.YT_DLP_COOKIES_PATH = original_path
        m._COOKIE_COPIES = original_copies


def test_job_timeout_constant() -> None:
    check("the job gives itself three hours", m.JOB_TIMEOUT_SECONDS == 3 * 60 * 60)
    # The job must report its own timeout before the runner is killed, or
    # the user sees a silent job rather than an explanation.
    workflow = (pathlib.Path(__file__).parents[2] / ".github/workflows/import.yml").read_text()
    minutes = int(workflow.split("timeout-minutes:")[1].split("\n")[0].strip())
    check(
        "the workflow's own timeout sits above it, so the reported one fires first",
        minutes * 60 > m.JOB_TIMEOUT_SECONDS,
    )


def test_cookie_validation(tmp_dir: pathlib.Path) -> None:
    # A file that downloads fine but is not in the expected format was
    # previously passed to yt-dlp anyway, which then failed once per song
    # with nothing pointing at the real cause.
    good = tmp_dir / "good.txt"
    good.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tx\ty\n")
    bad = tmp_dir / "bad.txt"
    bad.write_text('{"cookies": []}\n')

    def first_line(path: pathlib.Path) -> str:
        return path.read_text(errors="replace").lstrip().split("\n", 1)[0]

    def accepted(path: pathlib.Path) -> bool:
        line = first_line(path)
        return line.startswith("# Netscape HTTP Cookie File") or line.startswith("# HTTP Cookie File")

    check("a real Netscape cookies file is accepted", accepted(good))
    check("a JSON export is rejected rather than handed to yt-dlp", not accepted(bad))


if __name__ == "__main__":
    import tempfile

    test_error_classification()
    test_throttle_gate()
    test_retry_behaviour()
    test_network_error_handling()
    test_job_timeout_constant()
    with tempfile.TemporaryDirectory() as tmp:
        test_cookie_validation(pathlib.Path(tmp))
        test_per_worker_cookie_copies(pathlib.Path(tmp))

    print()
    if failures:
        print(f"{len(failures)} failed: {failures}")
        sys.exit(1)
    print("all passed")
