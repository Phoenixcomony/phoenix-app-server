import { enqueueJob, hashJobKey } from "./queue.js";
import { nanoid } from "nanoid";

const job = {
  id: nanoid(10),
  booking_id: "bk_test_001",   // مهم جداً
  nid: "1111111113",
  clinicId: "phoenix-main",
  doctorId: "test-doc",
  date: "2025-11-20",
  time: "10:00",
  job_key: hashJobKey({
    nid: "1111111113",
    date: "2025-11-20",
    time: "10:00",
    doctorId: "test-doc"
  }),
  attempts: 0,
  status: "queued"
};

await enqueueJob(job);
console.log("TEST JOB PUSHED!");
process.exit();
