"use strict";

const { ensureDaemon, request } = require("./lib/transport");
const { ROUTES } = require("../ipc/protocol");
const { pc, EMOJI, header, section, pair, table, delimiter } = require("./lib/theme");

/**
 * Main entry point for `wa webhook <subcommand>`
 */
async function cmdWebhook(argv) {
  const sub = argv.positional[0] || "help";
  const restPositional = argv.positional.slice(1);
  const flags = argv.flags || {};

  switch (sub.toLowerCase()) {
    case "list":
    case "ls":
      return webhookList(flags);
    case "add":
    case "create":
      return webhookAdd(restPositional, flags);
    case "get":
    case "show":
      return webhookGet(restPositional[0], flags);
    case "update":
      return webhookUpdate(restPositional[0], flags);
    case "delete":
    case "rm":
    case "remove":
      return webhookDelete(restPositional[0], flags);
    case "rotate":
    case "rotate-secret":
      return webhookRotateSecret(restPositional[0], flags);
    case "test":
      return webhookTest(restPositional[0], flags);
    case "deliveries":
    case "logs":
    case "history":
      return webhookDeliveries(flags);
    case "retry":
      return webhookRetry(restPositional[0], flags);
    case "stats":
      return webhookStats(flags);
    case "clean":
    case "prune":
      return webhookClean(flags);
    case "help":
    default:
      return webhookHelp();
  }
}

async function getClient() {
  const daemon = await ensureDaemon();
  return { base: daemon.base, token: daemon.token };
}

async function webhookList(flags) {
  const { base, token } = await getClient();
  const res = await request(base, token, "GET", ROUTES.WEBHOOKS);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to list webhooks")}`);
    process.exit(1);
  }

  const endpoints = res.endpoints || [];
  if (endpoints.length === 0) {
    console.log(`${pc.dim("No webhook endpoints registered.")} Use ${pc.cyan("wa webhook add <url>")} to add one.`);
    return;
  }

  console.log(`\n${pc.bold("Registered Webhook Endpoints:")} (${endpoints.length})\n`);
  const rows = [
    [pc.bold("ID"), pc.bold("NAME"), pc.bold("STATUS"), pc.bold("EVENTS"), pc.bold("URL")],
  ];

  for (const ep of endpoints) {
    const statusText = ep.enabled ? pc.green("enabled") : pc.red("disabled");
    const eventsText = ep.events.includes("*") ? "*" : ep.events.join(", ");
    rows.push([
      pc.cyan(ep.id),
      ep.name || pc.dim("(none)"),
      statusText,
      eventsText,
      ep.url,
    ]);
  }

  console.log(table(rows) + "\n");
}

async function webhookAdd(positional, flags) {
  const url = positional[0] || flags.url;
  if (!url) {
    console.error(`${EMOJI.fail} ${pc.red("Webhook destination URL is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook add <url> [--name <name>] [--events <events>]")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();

  const events = flags.events ? flags.events.split(",").map((s) => s.trim()) : ["*"];
  const name = flags.name || flags.n || null;
  const enabled = flags.disabled ? false : true;

  const security = {};
  if (flags["allow-localhost"] || flags.localhost) security.allowLocalhost = true;
  if (flags["allow-lan"] || flags.lan) security.allowLan = true;
  if (flags["insecure-http"] || flags["no-https"]) security.requireHttps = false;

  const payload = {
    url,
    name,
    events,
    enabled,
    security,
  };

  const res = await request(base, token, "POST", ROUTES.WEBHOOKS, payload);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to create webhook")}`);
    process.exit(1);
  }

  const ep = res.endpoint;
  console.log(`\n${EMOJI.ok} ${pc.green("Webhook endpoint registered successfully!")}\n`);
  console.log(pair("ID", pc.cyan(ep.id)));
  if (ep.name) console.log(pair("Name", ep.name));
  console.log(pair("URL", ep.url));
  console.log(pair("Status", ep.enabled ? pc.green("enabled") : pc.red("disabled")));
  console.log(pair("Events", ep.events.join(", ")));
  console.log("");
  console.log(`${pc.bold(pc.yellow("Signing Secret:"))} ${pc.bold(pc.cyan(ep.secret))}`);
  console.log(
    `${pc.yellow("⚠ IMPORTANT:")} Save this signing secret now. It is used to verify HMAC-SHA256 signatures and ${pc.bold("will not be shown again.")}\n`
  );
}

async function webhookGet(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook get <id>")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();
  const res = await request(base, token, "GET", `${ROUTES.WEBHOOKS}/${id}`);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || `Endpoint "${id}" not found`)}`);
    process.exit(1);
  }

  const ep = res.endpoint;
  console.log(`\n${pc.bold("Webhook Endpoint Details:")}\n`);
  console.log(pair("ID", pc.cyan(ep.id)));
  console.log(pair("Name", ep.name || pc.dim("(none)")));
  console.log(pair("URL", ep.url));
  console.log(pair("Status", ep.enabled ? pc.green("enabled") : pc.red("disabled")));
  console.log(pair("Secret", pc.dim(ep.secret)));
  console.log(pair("Events", ep.events.join(", ")));
  console.log(pair("Created", ep.createdAt));
  console.log(pair("Updated", ep.updatedAt));
  console.log("");
}

async function webhookUpdate(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook update <id> [--url <url>] [--enable|--disable]")}`);
    process.exit(1);
  }

  const updates = {};
  if (flags.url) updates.url = flags.url;
  if (flags.name !== undefined) updates.name = flags.name;
  if (flags.events) updates.events = flags.events.split(",").map((s) => s.trim());
  if (flags.enable) updates.enabled = true;
  if (flags.disable) updates.enabled = false;

  const { base, token } = await getClient();
  const res = await request(base, token, "PATCH", `${ROUTES.WEBHOOKS}/${id}`, updates);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || `Failed to update endpoint "${id}"`)}`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.ok} ${pc.green(`Webhook endpoint "${id}" updated successfully.`)}\n`);
}

async function webhookDelete(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook delete <id>")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();
  const res = await request(base, token, "DELETE", `${ROUTES.WEBHOOKS}/${id}`);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || `Failed to delete endpoint "${id}"`)}`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.ok} ${pc.green(`Webhook endpoint "${id}" deleted.`)}\n`);
}

async function webhookRotateSecret(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook rotate <id>")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();
  const res = await request(base, token, "POST", `${ROUTES.WEBHOOKS}/${id}/rotate-secret`);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || `Failed to rotate secret for "${id}"`)}`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.ok} ${pc.green(`Secret successfully rotated for endpoint "${id}"!`)}\n`);
  console.log(`${pc.bold(pc.yellow("New Signing Secret:"))} ${pc.bold(pc.cyan(res.newSecret))}`);
  console.log(
    `${pc.yellow("⚠ IMPORTANT:")} Update your receiver with this new secret. It ${pc.bold("will not be shown again.")}\n`
  );
}

async function webhookTest(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook test <id>")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();
  process.stdout.write(pc.dim(`Sending test event to webhook "${id}"...\n`));

  const res = await request(base, token, "POST", `${ROUTES.WEBHOOKS}/${id}/test`);

  if (!res.ok) {
    console.error(`\n${EMOJI.fail} ${pc.red(res.error?.message || "Test dispatch failed")}`);
    process.exit(1);
  }

  const attempt = res.attempt || {};
  if (res.delivered) {
    console.log(
      `\n${EMOJI.ok} ${pc.green(`Test event delivered successfully!`)} ${pc.dim(`(HTTP ${attempt.statusCode}, ${attempt.durationMs}ms)`)}\n`
    );
  } else {
    console.log(
      `\n${EMOJI.fail} ${pc.red(`Test delivery failed:`)} ${attempt.error || `HTTP ${attempt.statusCode}`} ${pc.dim(`(${attempt.durationMs}ms)`)}\n`
    );
  }
}

async function webhookDeliveries(flags) {
  const { base, token } = await getClient();
  const query = {};
  if (flags.endpoint || flags.endpointId) query.endpointId = flags.endpoint || flags.endpointId;
  if (flags.status) query.status = flags.status;
  if (flags.event || flags.eventType) query.eventType = flags.event || flags.eventType;
  if (flags.limit) query.limit = flags.limit;
  if (flags.offset) query.offset = flags.offset;

  const res = await request(base, token, "GET", `${ROUTES.WEBHOOKS}/deliveries`, null, { query });

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to query deliveries")}`);
    process.exit(1);
  }

  const deliveries = res.deliveries || [];
  if (deliveries.length === 0) {
    console.log(`\n${pc.dim("No delivery records found matching criteria.")}\n`);
    return;
  }

  console.log(`\n${pc.bold("Webhook Deliveries:")} (Total: ${res.total}, Showing: ${deliveries.length})\n`);
  const rows = [
    [pc.bold("DELIVERY ID"), pc.bold("EVENT"), pc.bold("STATUS"), pc.bold("ATTEMPTS"), pc.bold("TIME / CODE"), pc.bold("ERROR")],
  ];

  for (const d of deliveries) {
    let statusText = d.status;
    if (d.status === "succeeded") statusText = pc.green("succeeded");
    else if (d.status === "pending" || d.status === "delivering") statusText = pc.yellow(d.status);
    else if (d.status === "failed") statusText = pc.red("failed (retrying)");
    else if (d.status === "dead_letter") statusText = pc.bold(pc.red("dead_letter"));

    const codeText = d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : pc.dim("-");
    const errorText = d.lastError ? pc.red(d.lastError.slice(0, 32)) : pc.dim("-");

    rows.push([
      pc.cyan(d.id),
      d.eventType,
      statusText,
      `${d.attempts}/${d.maxAttempts}`,
      codeText,
      errorText,
    ]);
  }

  console.log(table(rows) + "\n");
}

async function webhookRetry(deliveryId, flags) {
  if (!deliveryId) {
    console.error(`${EMOJI.fail} ${pc.red("Delivery ID is required.")}`);
    console.error(`Usage: ${pc.cyan("wa webhook retry <deliveryId>")}`);
    process.exit(1);
  }

  const { base, token } = await getClient();
  const res = await request(base, token, "POST", `${ROUTES.WEBHOOKS}/deliveries/${deliveryId}/retry`);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || `Failed to retry delivery "${deliveryId}"`)}`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.ok} ${pc.green(`Delivery "${deliveryId}" re-enqueued for delivery.`)}\n`);
}

async function webhookStats(flags) {
  const { base, token } = await getClient();
  const res = await request(base, token, "GET", `${ROUTES.WEBHOOKS}/stats`);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to fetch stats")}`);
    process.exit(1);
  }

  console.log(`\n${pc.bold("Webhook Queue & Delivery Statistics:")}\n`);
  console.log(pair("Active In-Flight", pc.cyan(res.activeDeliveries)));
  console.log(pair("Pending Queue", pc.yellow(res.pending)));
  console.log(pair("Delivering", pc.yellow(res.delivering)));
  console.log(pair("Failed (Scheduled)", pc.red(res.failed)));
  console.log(pair("Succeeded (History)", pc.green(res.succeeded)));
  console.log(pair("Dead-Letter (Exhausted)", pc.bold(pc.red(res.deadLetter))));
  console.log(pair("Total History Entries", res.historyCount));
  console.log("");
}

async function webhookClean(flags) {
  const { base, token } = await getClient();
  const body = {};
  if (flags["max-entries"]) body.maxEntries = Number(flags["max-entries"]);
  if (flags["retention-days"]) body.retentionDays = Number(flags["retention-days"]);

  const res = await request(base, token, "POST", `${ROUTES.WEBHOOKS}/clean`, body);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Cleanup failed")}`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.ok} ${pc.green("Webhook delivery history cleaned successfully.")}`);
  console.log(pair("Remaining Entries", res.remaining));
  console.log("");
}

function webhookHelp() {
  console.log(`
${pc.bold("Usage:")} wa webhook <command> [options]

${pc.bold("Commands:")}
  ${pc.cyan("list")}                  List all registered webhook endpoints
  ${pc.cyan("add")} <url>             Register a new webhook endpoint (shows secret once)
  ${pc.cyan("get")} <id>              Show endpoint configuration details
  ${pc.cyan("update")} <id>           Update an existing endpoint
  ${pc.cyan("delete")} <id>           Delete a webhook endpoint
  ${pc.cyan("rotate")} <id>           Rotate signing secret (shows new secret once)
  ${pc.cyan("test")} <id>             Send an immediate test event to an endpoint
  ${pc.cyan("deliveries")}            View delivery history and queue records
  ${pc.cyan("retry")} <deliveryId>    Manually retry a failed or dead-letter delivery
  ${pc.cyan("stats")}                 View queue throughput and health statistics
  ${pc.cyan("clean")}                 Prune old delivery history records

${pc.bold("Options:")}
  --name <str>        Human-readable endpoint label
  --events <list>     Comma-separated event names (default: "*")
  --allow-localhost   Permit loopback / localhost destinations
  --allow-lan         Permit private RFC1918 LAN destinations
  --status <status>   Filter deliveries by status (pending, failed, succeeded, dead_letter)
  --limit <n>         Pagination limit
  --offset <n>        Pagination offset
`);
}

module.exports = {
  cmdWebhook,
};
