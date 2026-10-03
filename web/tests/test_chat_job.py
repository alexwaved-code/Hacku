import unittest

import server


class ChatJobTests(unittest.TestCase):
    def setUp(self):
        server.JOBS.clear()

    def test_a_disconnected_turn_stays_readable_until_it_finishes(self):
        job = server.begin_job("chat-12345678")
        with job.lock:
            job.events.append({"type": "delta", "text": "Looking"})
        self.assertEqual(server.job_view("chat-12345678", 0)["status"], "running")
        with job.lock:
            job.events.append({"type": "done", "messages": [{"role": "assistant", "content": "Done"}]})
            job.status = "done"
        view = server.job_view("chat-12345678", 1)
        self.assertEqual(view["status"], "done")
        self.assertEqual(view["events"][0]["type"], "done")

    def test_stop_marks_the_running_turn(self):
        server.begin_job("chat-abcdefgh")
        self.assertTrue(server.stop_job("chat-abcdefgh"))
        self.assertTrue(server.JOBS["chat-abcdefgh"].stop.is_set())

    def test_a_new_turn_stops_the_one_still_running(self):
        first = server.begin_job("chat-abcdefgh")
        server.begin_job("chat-abcdefgh")
        self.assertTrue(first.stop.is_set())

    def test_unknown_chat_is_missing(self):
        self.assertEqual(server.job_view("nope", 0)["status"], "missing")
        self.assertFalse(server.stop_job("short"))


if __name__ == "__main__":
    unittest.main()
