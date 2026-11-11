import os
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _try(f):
    try:
        return f()
    except (OSError, ValueError, IndexError, ZeroDivisionError):
        return None


def _cpu_times(proc: Path) -> tuple[int, int]:
    v = [int(x) for x in (proc / "stat").read_text().split("\n")[0].split()[1:]]
    return sum(v[:8]), v[3] + (v[4] if len(v) > 4 else 0)  # total, idle+iowait


class Stats:
    def __init__(self, proc_root="/proc", sys_root="/sys", hostfs="/hostfs"):
        self.proc, self.sys, self.hostfs = Path(proc_root), Path(sys_root), hostfs
        self.prev = _try(lambda: _cpu_times(self.proc))

    def cpu_pct(self):
        def f():
            cur = _cpu_times(self.proc)
            pt, pi = self.prev or (0, 0)
            self.prev = cur
            return round(100 * (1 - (cur[1] - pi) / (cur[0] - pt)), 1)
        return _try(f)

    def load1(self):
        return _try(lambda: float((self.proc / "loadavg").read_text().split()[0]))

    def mem_pct(self):
        def f():
            m = {k: int(v.split()[0]) for k, v in
                 (l.split(":", 1) for l in (self.proc / "meminfo").read_text().splitlines())}
            return round(100 * (1 - m["MemAvailable"] / m["MemTotal"]), 1)
        return _try(f)

    def disk_pct(self):
        def f():
            st = os.statvfs(self.hostfs if os.path.isdir(self.hostfs) else "/")
            used = st.f_blocks - st.f_bfree
            return round(100 * used / (used + st.f_bavail), 1)
        return _try(f)

    def cpu_temp(self):
        return _try(lambda: round(int((self.sys / "class/thermal/thermal_zone0/temp").read_text()) / 1000, 1))

    def boot_time(self):
        def f():
            bt = next(int(l.split()[1]) for l in (self.proc / "stat").read_text().splitlines()
                      if l.startswith("btime "))
            return datetime.fromtimestamp(bt, timezone.utc).isoformat()
        return _try(f)

    def throttled(self):
        return _try(lambda: int((self.sys / "devices/platform/soc/soc:firmware/get_throttled")
                                .read_text().strip(), 0) != 0)

    def snapshot(self) -> dict:
        return {k: getattr(self, k)() for k in
                ("cpu_temp", "cpu_pct", "mem_pct", "disk_pct", "load1", "boot_time", "throttled")}
