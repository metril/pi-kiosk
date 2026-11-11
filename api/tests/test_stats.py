from kiosk_api.stats import Stats


def fake(tmp_path):
    p, s = tmp_path / "proc", tmp_path / "sys"
    (p).mkdir()
    (s / "class/thermal/thermal_zone0").mkdir(parents=True)
    (s / "devices/platform/soc/soc:firmware").mkdir(parents=True)
    (p / "stat").write_text("cpu 100 0 100 700 100 0 0 0 0 0\nbtime 1700000000\n")
    (p / "loadavg").write_text("0.52 0.4 0.3 1/100 5\n")
    (p / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")
    (p / "uptime").write_text("3600.5 100.0\n")
    (s / "class/thermal/thermal_zone0/temp").write_text("48312\n")
    (s / "devices/platform/soc/soc:firmware/get_throttled").write_text("0x50000\n")
    return p, s


def test_values(tmp_path):
    p, s = fake(tmp_path)
    st = Stats(str(p), str(s), str(tmp_path))
    (p / "stat").write_text("cpu 200 0 200 800 100 0 0 0 0 0\nbtime 1700000000\n")  # +200 busy, +100 idle
    snap = st.snapshot()
    assert snap["cpu_pct"] == 66.7 and snap["load1"] == 0.52 and snap["mem_pct"] == 75.0
    assert snap["cpu_temp"] == 48.3 and snap["throttled"] is True
    assert snap["boot_time"] == "2023-11-14T22:13:20+00:00" == st.snapshot()["boot_time"] and 0 <= snap["disk_pct"] <= 100


def test_missing(tmp_path):
    st = Stats(str(tmp_path / "a"), str(tmp_path / "b"), str(tmp_path / "c"))
    snap = st.snapshot()
    assert snap["disk_pct"] is not None  # falls back to "/"
    assert all(v is None for k, v in snap.items() if k != "disk_pct")


def test_not_throttled(tmp_path):
    p, s = fake(tmp_path)
    (s / "devices/platform/soc/soc:firmware/get_throttled").write_text("0x0")
    assert Stats(str(p), str(s)).throttled() is False
