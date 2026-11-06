"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDaemon, request } = require("./lib/transport");
const { ROUTES } = require("../ipc/protocol");
const { pc, EMOJI, header, section, pair, table, delimiter } = require("./lib/theme");
const { setEndpointSecret } = require("../webhook/store");

/**
 * Reads a secret safely from stdin, file, or environment variable.
 * Never accepts secret directly as command line argument to avoid leaking into bash history.
 */
function readSecretFromFlags(flags) {
  // 1. Standard Input (highest preference)
  if (flags["secret-stdin"] || flags.stdin) {
    try {
      return fs.readFileSync(0, "utf8").trim();
    } catch (err) {
      throw new Error(`Failed to read secret from stdin: ${err.message}`);
    }
  }

  // 2. Secret file (permission-restricted file preference)
  if (flags["secret-file"]) {
    const filePath = path.resolve(flags["secret-file"]);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Secret file does not exist: "${filePath}"`);
    }
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch (err) {
      throw new Error(`Failed to read secret file "${filePath}": ${err.message}`);
    }
  }

  // 3. Environment variable (note: inspectable by root/same-UID processes via /proc/<pid>/environ)
  if (flags["secret-env"]) {
    const varName = flags["secret-env"];
    const val = process.env[varName];
    if (!val) {
      throw new Error(`Environment variable "${varName}" is empty or not set.`);
    }
    return val.trim();
  }

  return null;
}

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
    case "set-secret":
      return webhookSetSecret(restPositional[0], flags);
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
    case "route":
    case "routes":
      return webhookRoute(restPositional, flags);
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
    [pc.bold("ID"), pc.bold("NAME"), pc.bold("PROFILE"), pc.bold("STATUS"), pc.bold("EVENTS"), pc.bold("URL")],
  ];

  for (const ep of endpoints) {
    const statusText = ep.enabled ? pc.green("enabled") : pc.red("disabled");
    const eventsText = ep.events.includes("*") ? "*" : ep.events.join(", ");
    rows.push([
      pc.cyan(ep.id),
      ep.name || pc.dim("(none)"),
      ep.profile || "generic",
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
    console.error(`Usage: ${pc.cyan("wa webhook add <url> [--profile <generic|openbot>] [--name <name>] [--events <events>]")}`);
    process.exit(1);
  }

  let secret;
  try {
    secret = readSecretFromFlags(flags);
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
    process.exit(1);
  }

  const { base, token } = await getClient();

  const events = flags.events ? flags.events.split(",").map((s) => s.trim()) : ["*"];
  const name = flags.name || flags.n || null;
  const enabled = flags.disabled ? false : true;
  const profile = flags.profile || "generic";

  const security = {};
  if (flags["allow-localhost"] || flags.localhost) security.allowLocalhost = true;
  if (flags["allow-lan"] || flags.lan) security.allowLan = true;
  if (flags["insecure-http"] || flags["no-https"]) security.requireHttps = false;

  const payload = {
    url,
    name,
    events,
    enabled,
    profile,
    security,
  };
  if (secret) payload.secret = secret;

  const res = await request(base, token, "POST", ROUTES.WEBHOOKS, payload);

  if (!res.ok) {
    console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to create webhook")}`);
    process.exit(1);
  }

  const ep = res.endpoint;
  console.log(`\n${EMOJI.ok} ${pc.green("Webhook endpoint registered successfully!")}\n`);
  console.log(pair("ID", pc.cyan(ep.id)));
  if (ep.name) console.log(pair("Name", ep.name));
  console.log(pair("Profile", ep.profile || "generic"));
  console.log(pair("URL", ep.url));
  console.log(pair("Status", ep.enabled ? pc.green("enabled") : pc.red("disabled")));
  console.log(pair("Events", ep.events.join(", ")));
  console.log("");
  if (secret) {
    console.log(`${pc.bold(pc.green("Secret Configured:"))} Existing secret securely linked to endpoint.\n`);
  } else {
    console.log(`${pc.bold(pc.yellow("Generated Secret:"))} ${pc.bold(pc.cyan(ep.secret))}`);
    console.log(
      `${pc.yellow("⚠ IMPORTANT:")} Save this signing secret now. It is used to verify signatures and ${pc.bold("will not be shown again.")}\n`
    );
  }
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
  console.log(pair("Profile", ep.profile || "generic"));
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
    console.error(`Usage: ${pc.cyan("wa webhook update <id> [--url <url>] [--profile <generic|openbot>] [--enable|--disable]")}`);
    process.exit(1);
  }

  const updates = {};
  if (flags.url) updates.url = flags.url;
  if (flags.name !== undefined) updates.name = flags.name;
  if (flags.profile) updates.profile = flags.profile;
  if (flags.events) updates.events = flags.events.split(",").map((s) => s.trim());
  if (flags.enable) updates.enabled = true;
  if (flags.disable) updates.enabled = false;
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

async function webhookSetSecret(id, flags) {
  if (!id) {
    console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
    console.error(
      `Usage: ${pc.cyan("wa webhook set-secret <id> <--secret-stdin | --secret-file <path> | --secret-env <var>>")}`
    );
    process.exit(1);
  }

  let secret;
  try {
    secret = readSecretFromFlags(flags);
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
    process.exit(1);
  }

  if (!secret) {
    console.error(`${EMOJI.fail} ${pc.red("No signing secret provided.")}`);
    console.error(
      `Provide secret using ${pc.cyan("--secret-stdin")} (recommended), ${pc.cyan("--secret-file <path>")}, or ${pc.cyan("--secret-env <var>")}.`
    );
    process.exit(1);
  }

  try {
    const updated = setEndpointSecret(id, secret);
    console.log(`\n${EMOJI.ok} ${pc.green(`Signing secret successfully updated for endpoint "${id}".`)}\n`);
    console.log(pair("ID", pc.cyan(updated.id)));
    console.log(pair("Profile", updated.profile || "generic"));
    console.log(pair("Masked Secret", pc.dim(updated.secret)));
    console.log("");
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
    process.exit(1);
  }
}

async function webhookRoute(positional, flags) {
  const action = (positional[0] || "list").toLowerCase();
  const rest = positional.slice(1);
  const { base, token } = await getClient();
  const routesUrl = `${ROUTES.WEBHOOKS}/routes`;

  if (action === "list" || action === "ls") {
    const res = await request(base, token, "GET", routesUrl);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to list routing rules")}`);
      process.exit(1);
    }

    console.log(header("Universal Webhook Routing Configuration"));

    // 1. Explicit contact rules
    const rules = res.rules || [];
    console.log(section("Explicit Contact Rules"));
    if (rules.length === 0) {
      console.log(pc.dim("  No explicit contact rules defined.\n"));
    } else {
      const rows = [
        [
          pc.bold("RULE ID"),
          pc.bold("CONTACT"),
          pc.bold("TARGET ENDPOINT"),
          pc.bold("PRIORITY"),
          pc.bold("STATUS"),
          pc.bold("NAME"),
        ],
      ];
      for (const r of rules) {
        rows.push([
          pc.cyan(r.id),
          r.rawContact || r.contact,
          r.endpointId,
          String(r.priority || 0),
          r.enabled ? pc.green("enabled") : pc.dim("disabled"),
          r.name || pc.dim("-"),
        ]);
      }
      console.log(table(rows) + "\n");
    }

    // 2. Per-endpoint allowlists and exclusions
    const endpointRules = res.endpointRules || {};
    const epKeys = Object.keys(endpointRules);
    console.log(section("Endpoint Allow & Exclusion Rules"));
    if (epKeys.length === 0) {
      console.log(pc.dim("  No per-endpoint allow/exclusion rules defined.\n"));
    } else {
      for (const epId of epKeys) {
        const er = endpointRules[epId];
        console.log(`  ${pc.cyan(epId)}:`);
        if (er.allowlist && er.allowlist.length > 0) {
          console.log(`    Allowlist: ${er.allowlist.join(", ")}`);
        }
        if (er.exclusion && er.exclusion.length > 0) {
          console.log(`    Exclusion: ${pc.red(er.exclusion.join(", "))}`);
        }
      }
      console.log("");
    }

    // 3. Fallback configuration
    const fallback = res.fallback || {};
    console.log(section("Fallback Configuration"));
    console.log(pair("Fallback Endpoint", fallback.endpointId ? pc.cyan(fallback.endpointId) : pc.dim("None configured")));
    console.log(pair("Status", fallback.enabled ? pc.green("enabled") : pc.dim("disabled")));
    console.log("");
    return;
  }

  if (action === "add" || action === "create") {
    const contact = rest[0] || flags.contact;
    const endpointId = rest[1] || flags.endpoint || flags.endpointId;

    if (!contact || !endpointId) {
      console.error(`${EMOJI.fail} ${pc.red("Contact and endpointId are required.")}`);
      console.error(`Usage: ${pc.cyan("wa webhook route add <contact> <endpointId> [--priority <n>] [--name <str>]")}`);
      process.exit(1);
    }

    const payload = {
      contact,
      endpointId,
      priority: flags.priority ? parseInt(flags.priority, 10) : 0,
      name: flags.name || null,
      enabled: flags.disabled ? false : true,
    };

    const res = await request(base, token, "POST", routesUrl, payload);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to add routing rule")}`);
      process.exit(1);
    }

    const rule = res.rule;
    console.log(`\n${EMOJI.ok} ${pc.green("Routing rule added successfully!")}\n`);
    console.log(pair("Rule ID", pc.cyan(rule.id)));
    console.log(pair("Contact", rule.rawContact || rule.contact));
    console.log(pair("Endpoint ID", rule.endpointId));
    console.log(pair("Priority", String(rule.priority)));
    console.log(pair("Status", rule.enabled ? pc.green("enabled") : pc.dim("disabled")));
    console.log("");
    return;
  }

  if (action === "update") {
    const id = rest[0];
    if (!id) {
      console.error(`${EMOJI.fail} ${pc.red("Rule ID is required.")}`);
      console.error(`Usage: ${pc.cyan("wa webhook route update <id> [--contact <contact>] [--endpoint <id>] [--priority <n>] [--enable|--disable]")}`);
      process.exit(1);
    }

    const payload = {};
    if (flags.contact) payload.contact = flags.contact;
    if (flags.endpoint || flags.endpointId) payload.endpointId = flags.endpoint || flags.endpointId;
    if (flags.priority !== undefined) payload.priority = parseInt(flags.priority, 10);
    if (flags.name !== undefined) payload.name = flags.name;
    if (flags.enable) payload.enabled = true;
    if (flags.disable || flags.disabled) payload.enabled = false;

    const res = await request(base, token, "PATCH", `${routesUrl}/${id}`, payload);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to update routing rule")}`);
      process.exit(1);
    }

    console.log(`\n${EMOJI.ok} ${pc.green("Routing rule updated successfully!")}\n`);
    return;
  }

  if (action === "delete" || action === "rm" || action === "remove") {
    const id = rest[0];
    if (!id) {
      console.error(`${EMOJI.fail} ${pc.red("Rule ID is required.")}`);
      console.error(`Usage: ${pc.cyan("wa webhook route delete <id>")}`);
      process.exit(1);
    }

    const res = await request(base, token, "DELETE", `${routesUrl}/${id}`);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to delete routing rule")}`);
      process.exit(1);
    }

    console.log(`\n${EMOJI.ok} ${pc.green(`Routing rule "${id}" deleted.`)}\n`);
    return;
  }

  if (action === "fallback") {
    const endpointId = rest[0];
    const enabled = flags.disable ? false : true;

    if (!endpointId && !flags.disable) {
      console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required for fallback.")}`);
      console.error(`Usage: ${pc.cyan("wa webhook route fallback <endpointId> [--disable]")}`);
      process.exit(1);
    }

    const payload = {
      endpointId: endpointId || null,
      enabled: endpointId ? enabled : false,
    };

    const res = await request(base, token, "POST", `${routesUrl}/fallback`, payload);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to configure fallback endpoint")}`);
      process.exit(1);
    }

    console.log(`\n${EMOJI.ok} ${pc.green("Fallback endpoint configured successfully!")}\n`);
    console.log(pair("Fallback Endpoint", res.fallback?.endpointId ? pc.cyan(res.fallback.endpointId) : pc.dim("None")));
    console.log(pair("Status", res.fallback?.enabled ? pc.green("enabled") : pc.dim("disabled")));
    console.log("");
    return;
  }

  if (action === "endpoint") {
    const endpointId = rest[0];
    if (!endpointId) {
      console.error(`${EMOJI.fail} ${pc.red("Endpoint ID is required.")}`);
      console.error(`Usage: ${pc.cyan("wa webhook route endpoint <endpointId> [--allow <contacts>] [--exclude <contacts>]")}`);
      process.exit(1);
    }

    const payload = {};
    if (flags.allow) {
      payload.allowlist = flags.allow.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (flags.exclude) {
      payload.exclusion = flags.exclude.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const res = await request(base, token, "POST", `${routesUrl}/endpoints/${endpointId}`, payload);
    if (!res.ok) {
      console.error(`${EMOJI.fail} ${pc.red(res.error?.message || "Failed to configure endpoint rules")}`);
      process.exit(1);
    }

    console.log(`\n${EMOJI.ok} ${pc.green(`Rules updated for endpoint "${endpointId}".`)}\n`);
    if (res.allowlist) console.log(pair("Allowlist", res.allowlist.join(", ") || pc.dim("Empty")));
    if (res.exclusion) console.log(pair("Exclusion", pc.red(res.exclusion.join(", ")) || pc.dim("Empty")));
    console.log("");
    return;
  }

  console.error(`${EMOJI.fail} ${pc.red(`Unknown route action: "${action}"`)}`);
  console.error(`Supported actions: list, add, update, delete, fallback, endpoint`);
  process.exit(1);
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
  ${pc.cyan("set-secret")} <id>       Configure signing secret via stdin, file, or env var
  ${pc.cyan("rotate")} <id>           Rotate signing secret (shows new secret once)
  ${pc.cyan("test")} <id>             Send an immediate test event to an endpoint
  ${pc.cyan("deliveries")}            View delivery history and queue records
  ${pc.cyan("retry")} <deliveryId>    Manually retry a failed or dead-letter delivery
  ${pc.cyan("stats")}                 View queue throughput and health statistics
  ${pc.cyan("clean")}                 Prune old delivery history records
  ${pc.cyan("route")} <action>        Manage contact-based webhook routing rules

${pc.bold("Route Actions:")}
  wa webhook route list                      List all contact rules, endpoint filters, and fallback
  wa webhook route add <contact> <epId>      Add explicit contact-to-endpoint routing rule
  wa webhook route update <id> [options]     Update explicit routing rule
  wa webhook route delete <id>               Delete a routing rule
  wa webhook route fallback <epId>           Configure default fallback endpoint
  wa webhook route endpoint <epId>           Configure per-endpoint allowlist & exclusion rules

${pc.bold("Options:")}
  --profile <profile> Signing profile: "generic" (default) or "openbot"
  --name <str>        Human-readable endpoint label
  --events <list>     Comma-separated event names (default: "*")
  --allow-localhost   Permit loopback / localhost destinations
  --allow-lan         Permit private RFC1918 LAN destinations
  --secret-stdin      Read signing secret from stdin (recommended; no shell history leak)
  --secret-file <path> Read signing secret from permission-restricted file (0600)
  --secret-env <var>  Read signing secret from environment variable (inspectable via /proc)
  --status <status>   Filter deliveries by status (pending, failed, succeeded, dead_letter)
  --limit <n>         Pagination limit
  --offset <n>        Pagination offset
`);
}

module.exports = {
  cmdWebhook,
};
