# Prepare Agent context for a Deliverable

Paste this prompt into your agent session in the repository where you will work.
Replace the placeholders with the Project and Deliverable titles and IDs from the Plan Library.
The agent needs the Inbox tools (`read_planning` and `request_planning`, or their `plannotator_inbox` actions).

```text
Use Plannotator Plan Library for deliverable <deliverable title and ID> in project <project title and ID>.
Read the existing library records with read_planning.
Read the repository code and the relevant designs and service baselines.
Create or revise an implementation-plan document tied to this deliverable with request_planning.
Include the scope, implementation steps, acceptance criteria, and required tests.
Link the relevant design documents through linkedDocumentIds.
Tell me which exact revision to approve in Plans → Plan & approve.
Then guide me through Plans → Agent context → Start an implementation run.
Ask me to use your actual agent session ID. Do not invent an ID.
After I start the run, read every page of its pinned context with read_planning and run_id.
Summarize the approved scope and conditions. Do not implement yet.
```

The person approves the exact plan revision before the run starts. The agent cannot approve it on the person's behalf.
After the run starts, the agent reads its pinned context. A later draft does not replace that context.
