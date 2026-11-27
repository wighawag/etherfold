<!-- dorfl-sidecar: item=task:triggers-ed25519-delegated-identity type=task slug=triggers-ed25519-delegated-identity allAnswered=false -->

## Q1

**'task:triggers-ed25519-delegated-identity' was bounced — how should we proceed?**

> Prerequisite missing: no released push-notification-server reads delegated-identity 0.2.0's proof. `@push-notification/server@0.2.0`, the latest, depends on `delegated-identity ^0.1.0`, and `@push-notification/cli@0.2.0` uses it. Push-notification-server's own task `ed25519-delegated-identity` is still in its work/tasks/ready/ (origin/main head: "promote: ed25519-delegated-identity to ready"). This task's suite registers the SAME identity at a real in-process push server (packages/triggers/test/utils/push-server.ts `register` via `signedPost`, used by push-server.test.ts and greetings.test.ts). So moving test/utils/identity.ts to the Ed25519 key set breaks those suites against the released server. Using two identities per user instead makes the criterion "The same client body registers at push-notification-server and at the trigger service" false. Second, the body field carrying the key set is a cross-repo wire contract that neither task names (the delegated-identity README example uses `keySet: {signing: {publicKey}, encryption: {publicKey}}`). It should be fixed in push-notification-server's task, not invented here first. Suggested re-scope: add push-notification-server's ed25519-delegated-identity release as a blocker, fix the body field name there (`keySet`, as in the README), then build this task with `@push-notification/cli` raised to that release alongside `delegated-identity` ^0.2.0. Alternatively, drop the "same client body" criterion and say how push-server.test.ts and greetings.test.ts should behave until the push server releases.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
