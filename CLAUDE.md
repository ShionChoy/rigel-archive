# Rigel Archive

Project notes for agents.

## Conventions

- **After every deployment, check Cloudflare for anything left running that keeps billing.** The main risk is the `rigel-archive-processor` container (standard-4, 12 GiB, billed by running time): confirm it goes back to sleep once its queues are empty, and that no extra instances, Durable Objects, crons or other resources were added or left active by the deploy. Report anything unexpected to the user before moving on, so there are no surprise charges.
