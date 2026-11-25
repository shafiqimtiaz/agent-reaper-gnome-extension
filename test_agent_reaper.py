import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("reaper", os.path.join(os.path.dirname(__file__), "agent-reaper.py"))
reaper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reaper)

SYSTEMD = 2457
DAY = 86400
CLAUDE = {"CLAUDECODE": "1", "CLAUDE_PID": "4000"}


def proc(pid, ppid, cmd, state="S", tty=0, age=DAY, cwd="/home/u", comm=None, env=None):
    return dict(pid=pid, ppid=ppid, cmd=cmd, state=state, tty=tty, age=age, cwd=cwd, start=pid,
                comm=comm or (os.path.basename(cmd.split()[0]) if cmd else ""), rss=10, swap=20, env=env or {})


def table(*procs):
    base = [proc(1, 0, "/sbin/init", comm="systemd"), proc(SYSTEMD, 1, "/usr/lib/systemd/systemd --user", comm="systemd")]
    return {p["pid"]: p for p in base + list(procs)}


def zombies(parent, first, count):
    return [proc(first + i, parent, "", state="Z", comm="node") for i in range(count)]


class Owner(unittest.TestCase):
    def test_markers_name_the_agent(self):
        cases = [(CLAUDE, "Claude Code"), ({"OPENCODE": "1"}, "OpenCode"), ({"CODEX_THREAD_ID": "t"}, "Codex"),
                 ({"GEMINI_CLI": "1"}, "Gemini CLI"), ({"PI_CODING_AGENT": "true"}, "pi"),
                 ({"CODEBUFF_LAUNCHER_PID": "9"}, "Codebuff"),
                 ({"VSCODE_GIT_ASKPASS_NODE": "/usr/share/antigravity/antigravity"}, "Antigravity"), ({}, None)]
        for env, name in cases:
            self.assertEqual(reaper.owner(env)[0], name, env)


class Rules(unittest.TestCase):
    def found(self, procs):
        return reaper.candidates(procs, 3600)[0]

    def test_desktop_app_with_zombies_is_kept(self):
        procs = table(proc(500, SYSTEMD, "/usr/lib/slack/slack"), *zombies(500, 501, 3))
        self.assertNotIn(500, self.found(procs))

    def test_stopped_agent_with_zombies_is_found(self):
        procs = table(proc(600, SYSTEMD, "claude --chrome", state="T"), *zombies(600, 601, 5))
        self.assertIn(600, self.found(procs))

    def test_orphan_without_agent_marker_is_kept(self):
        procs = table(proc(700, SYSTEMD, "bash backfill.sh", comm="bash"), proc(701, 700, "python3 migrate.py"))
        self.assertEqual(self.found(procs), {})

    def test_orphaned_agent_task_is_found_once(self):
        procs = table(proc(800, SYSTEMD, "bash -c ui", comm="bash", env=CLAUDE),
                      proc(801, 800, "npm run start:dev", env=CLAUDE),
                      proc(802, 801, "node /repo/node_modules/.bin/vite", env=CLAUDE))
        found = self.found(procs)
        self.assertEqual(list(found), [800])
        self.assertEqual(found[800][0], "Claude Code")

    def test_task_of_live_agent_is_kept(self):
        procs = table(proc(4000, 3000, "claude", tty=34816), proc(801, 4000, "npm run dev", env=CLAUDE))
        self.assertEqual(self.found(procs), {})

    def test_detached_task_of_closed_agent_is_found(self):
        procs = table(proc(3000, SYSTEMD, "herdr-core"), proc(801, 3000, "node server.js", env=CLAUDE))
        self.assertIn(801, self.found(procs))

    def test_task_of_closed_agent_in_open_terminal_is_kept(self):
        procs = table(proc(3000, SYSTEMD, "bash", tty=34817), proc(801, 3000, "vite", tty=34817, env=CLAUDE))
        self.assertEqual(self.found(procs), {})

    def test_young_process_is_kept(self):
        procs = table(proc(900, SYSTEMD, "claude --chrome", state="T", age=60))
        self.assertNotIn(900, self.found(procs))


class KillOrder(unittest.TestCase):
    def test_protected_descendant_is_skipped_and_children_go_first(self):
        procs = table(proc(800, SYSTEMD, "bash -c ui", comm="bash"),
                      proc(801, 800, "node /repo/node_modules/.bin/vite"),
                      proc(802, 800, "python3 /stack/tray/stack_tray.py"))
        kids = reaper.children_map(procs)
        order = reaper.kill_order(procs, kids, [800])
        self.assertNotIn(802, order)
        self.assertEqual(order, [801, 800])


if __name__ == "__main__":
    unittest.main()
