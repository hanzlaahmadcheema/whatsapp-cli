"use strict";

const { URL } = require("url");
const { ok, fail } = require("../ipc/protocol");
const {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  rotateEndpointSecret,
  DeliveryQueue,
  dispatchWebhookRequest,
  generateEventId,
  addRule,
  updateRule,
  deleteRule,
  getRule,
  listRules,
  setFallback,
  getFallback,
  setEndpointRules,
  getEndpointRules,
  loadRoutingConfig,
} = require("../webhook");

/**
 * Handles all REST API requests under /webhooks
 */
async function handleWebhookRoute(server, req, res, pathname, method) {
  const queue = server.getWebhookQueue();

  // Helper for parsing query params
  const qs = new URL(req.url, "http://x").searchParams;

  // 1. GET /webhooks - List endpoints
  if (pathname === "/webhooks" && method === "GET") {
    try {
      const endpoints = listEndpoints(queue.dataDir, { exposeSecret: false });
      return server.json(res, 200, ok({ count: endpoints.length, endpoints }));
    } catch (err) {
      return server.json(res, 500, fail("WEBHOOK_ERROR", err.message));
    }
  }

  // 2. POST /webhooks - Register new endpoint
  if (pathname === "/webhooks" && method === "POST") {
    return server.withBody(req, res, async (body) => {
      try {
        if (!body || !body.url) {
          return server.json(
            res,
            400,
            fail("BAD_REQUEST", "Endpoint `url` is required.")
          );
        }
        // createEndpoint validates URL and SSRF constraints
        const endpoint = createEndpoint(body, queue.dataDir);
        // Expose plaintext secret only on creation
        return server.json(res, 201, ok({ endpoint }));
      } catch (err) {
        return server.json(res, 400, fail("VALIDATION_ERROR", err.message));
      }
    });
  }

  // 3. GET /webhooks/stats - Queue statistics
  if (pathname === "/webhooks/stats" && method === "GET") {
    try {
      const stats = queue.getStats();
      return server.json(res, 200, ok(stats));
    } catch (err) {
      return server.json(res, 500, fail("QUEUE_ERROR", err.message));
    }
  }

  // 4. POST /webhooks/clean - Prune history
  if (pathname === "/webhooks/clean" && method === "POST") {
    return server.withBody(req, res, async (body) => {
      try {
        const { maxEntries, retentionDays } = body || {};
        const options = {};
        if (maxEntries !== undefined) options.maxEntries = Number(maxEntries);
        if (retentionDays !== undefined) {
          options.retentionMs = Number(retentionDays) * 24 * 60 * 60 * 1000;
        }

        const remaining = queue.pruneHistory(options);
        const stats = queue.getStats();
        return server.json(
          res,
          200,
          ok({
            remaining,
            stats,
          })
        );
      } catch (err) {
        return server.json(res, 500, fail("CLEANUP_ERROR", err.message));
      }
    });
  }

  // 5. GET /webhooks/deliveries - Query delivery logs
  if (pathname === "/webhooks/deliveries" && method === "GET") {
    try {
      const filter = {
        endpointId: qs.get("endpointId") || undefined,
        status: qs.get("status") || undefined,
        eventType: qs.get("eventType") || undefined,
        limit: qs.get("limit") ? parseInt(qs.get("limit"), 10) : 50,
        offset: qs.get("offset") ? parseInt(qs.get("offset"), 10) : 0,
      };

      const result = queue.listDeliveries(filter);
      return server.json(res, 200, ok(result));
    } catch (err) {
      return server.json(res, 500, fail("DELIVERY_QUERY_ERROR", err.message));
    }
  }

  // 6. Match /webhooks/deliveries/:deliveryId routes
  const deliveryPrefix = "/webhooks/deliveries/";
  if (pathname.startsWith(deliveryPrefix)) {
    const rest = pathname.slice(deliveryPrefix.length);
    const [deliveryId, action] = rest.split("/");

    if (!deliveryId) {
      return server.json(res, 400, fail("BAD_REQUEST", "Missing delivery ID."));
    }

    // POST /webhooks/deliveries/:deliveryId/retry
    if (action === "retry" && method === "POST") {
      try {
        const retried = queue.retryDelivery(deliveryId);
        return server.json(res, 200, ok({ delivery: retried }));
      } catch (err) {
        const status = err.message.includes("currently in progress")
          ? 409
          : err.message.includes("not found")
          ? 404
          : 400;
        return server.json(res, status, fail("RETRY_ERROR", err.message));
      }
    }

    // GET /webhooks/deliveries/:deliveryId
    if (!action && method === "GET") {
      const delivery = queue.getDelivery(deliveryId);
      if (!delivery) {
        return server.json(
          res,
          404,
          fail("NOT_FOUND", `Delivery not found: "${deliveryId}"`)
        );
      }
      return server.json(res, 200, ok({ delivery }));
    }

    return server.json(
      res,
      404,
      fail("NOT_FOUND", `No delivery route for ${method} ${pathname}`)
    );
  }

  // 6.5. Match /webhooks/routes routes
  const routesPrefix = "/webhooks/routes";
  if (pathname === routesPrefix || pathname.startsWith(routesPrefix + "/")) {
    const subPath = pathname.slice(routesPrefix.length);

    // GET /webhooks/routes - Overview / list of all rules and config
    if ((subPath === "" || subPath === "/") && method === "GET") {
      try {
        const config = loadRoutingConfig(queue.dataDir);
        return server.json(res, 200, ok(config));
      } catch (err) {
        return server.json(res, 500, fail("ROUTING_ERROR", err.message));
      }
    }

    // POST /webhooks/routes - Add an explicit rule
    if ((subPath === "" || subPath === "/") && method === "POST") {
      return server.withBody(req, res, async (body) => {
        try {
          const rule = addRule(body || {}, queue.dataDir);
          return server.json(res, 201, ok({ rule }));
        } catch (err) {
          return server.json(res, 400, fail("VALIDATION_ERROR", err.message));
        }
      });
    }

    // Fallback routes: /webhooks/routes/fallback
    if (subPath === "/fallback") {
      if (method === "GET") {
        try {
          const fallback = getFallback(queue.dataDir);
          return server.json(res, 200, ok({ fallback }));
        } catch (err) {
          return server.json(res, 500, fail("ROUTING_ERROR", err.message));
        }
      }
      if (method === "POST" || method === "PUT") {
        return server.withBody(req, res, async (body) => {
          try {
            const fallback = setFallback(body || {}, queue.dataDir);
            return server.json(res, 200, ok({ fallback }));
          } catch (err) {
            return server.json(res, 400, fail("VALIDATION_ERROR", err.message));
          }
        });
      }
    }

    // Per-endpoint rules: /webhooks/routes/endpoints/:endpointId
    if (subPath.startsWith("/endpoints/")) {
      const epId = subPath.slice("/endpoints/".length);
      if (!epId) {
        return server.json(res, 400, fail("BAD_REQUEST", "Missing endpoint ID."));
      }
      if (method === "GET") {
        try {
          const rules = getEndpointRules(epId, queue.dataDir);
          return server.json(res, 200, ok({ endpointId: epId, ...rules }));
        } catch (err) {
          return server.json(res, 500, fail("ROUTING_ERROR", err.message));
        }
      }
      if (method === "POST" || method === "PUT") {
        return server.withBody(req, res, async (body) => {
          try {
            const rules = setEndpointRules(epId, body || {}, queue.dataDir);
            return server.json(res, 200, ok(rules));
          } catch (err) {
            return server.json(res, 400, fail("VALIDATION_ERROR", err.message));
          }
        });
      }
    }

    // Specific rule by ID: /webhooks/routes/:id
    const ruleId = subPath.slice(1);
    if (ruleId && !ruleId.includes("/")) {
      if (method === "GET") {
        const rule = getRule(ruleId, queue.dataDir);
        if (!rule) {
          return server.json(
            res,
            404,
            fail("NOT_FOUND", `Routing rule not found: "${ruleId}"`)
          );
        }
        return server.json(res, 200, ok({ rule }));
      }
      if (method === "PATCH" || method === "PUT") {
        return server.withBody(req, res, async (body) => {
          try {
            const updated = updateRule(ruleId, body || {}, queue.dataDir);
            return server.json(res, 200, ok({ rule: updated }));
          } catch (err) {
            const status = err.message.includes("not found") ? 404 : 400;
            return server.json(res, status, fail("UPDATE_ERROR", err.message));
          }
        });
      }
      if (method === "DELETE") {
        try {
          const deleted = deleteRule(ruleId, queue.dataDir);
          return server.json(res, 200, ok({ deleted: true, id: deleted.id }));
        } catch (err) {
          const status = err.message.includes("not found") ? 404 : 400;
          return server.json(res, status, fail("DELETE_ERROR", err.message));
        }
      }
    }

    return server.json(
      res,
      404,
      fail("NOT_FOUND", `No routing route for ${method} ${pathname}`)
    );
  }

  // 7. Match /webhooks/:id routes
  const idPrefix = "/webhooks/";
  if (pathname.startsWith(idPrefix)) {
    const rest = pathname.slice(idPrefix.length);
    const [id, action] = rest.split("/");

    if (!id) {
      return server.json(res, 400, fail("BAD_REQUEST", "Missing endpoint ID."));
    }

    // POST /webhooks/:id/rotate-secret
    if (action === "rotate-secret" && method === "POST") {
      try {
        const result = rotateEndpointSecret(id, queue.dataDir);
        // Returns unmasked newSecret once
        return server.json(
          res,
          200,
          ok({
            endpoint: result.endpoint,
            newSecret: result.newSecret,
          })
        );
      } catch (err) {
        const status = err.message.includes("not found") ? 404 : 400;
        return server.json(res, status, fail("ROTATION_ERROR", err.message));
      }
    }

    // POST /webhooks/:id/test
    if (action === "test" && method === "POST") {
      return server.withBody(req, res, async (body) => {
        try {
          const endpoint = getEndpoint(id, queue.dataDir, {
            exposeSecret: true,
          });
          if (!endpoint) {
            return server.json(
              res,
              404,
              fail("NOT_FOUND", `Webhook endpoint not found: "${id}"`)
            );
          }

          const eventId = generateEventId();
          const testPayload = (body && body.payload) || {
            event: "webhook.test",
            timestamp: Math.floor(Date.now() / 1000),
            data: {
              message: "WhatsApp CLI Webhook Test Event",
              endpointId: id,
              endpointName: endpoint.name,
            },
          };

          const attempt = await dispatchWebhookRequest({
            url: endpoint.url,
            payload: testPayload,
            secret: endpoint.secret,
            eventId,
            deliveryId: `del_test_${Date.now()}`,
            profile: endpoint.profile || "generic",
            options: {
              security: endpoint.security,
              timeoutMs: queue.timeoutMs,
              profile: endpoint.profile || "generic",
            },
          });

          return server.json(
            res,
            attempt.success ? 200 : 502,
            ok({
              delivered: attempt.success,
              attempt,
            })
          );
        } catch (err) {
          return server.json(
            res,
            500,
            fail("TEST_DISPATCH_ERROR", err.message)
          );
        }
      });
    }

    // GET /webhooks/:id
    if (!action && method === "GET") {
      const endpoint = getEndpoint(id, queue.dataDir, { exposeSecret: false });
      if (!endpoint) {
        return server.json(
          res,
          404,
          fail("NOT_FOUND", `Webhook endpoint not found: "${id}"`)
        );
      }
      return server.json(res, 200, ok({ endpoint }));
    }

    // PATCH /webhooks/:id or PUT /webhooks/:id
    if (!action && (method === "PATCH" || method === "PUT")) {
      return server.withBody(req, res, async (body) => {
        try {
          const updated = updateEndpoint(id, body || {}, queue.dataDir);
          return server.json(res, 200, ok({ endpoint: updated }));
        } catch (err) {
          const status = err.message.includes("not found") ? 404 : 400;
          return server.json(res, status, fail("UPDATE_ERROR", err.message));
        }
      });
    }

    // DELETE /webhooks/:id
    if (!action && method === "DELETE") {
      try {
        const deleted = deleteEndpoint(id, queue.dataDir);
        return server.json(res, 200, ok({ deleted: true, id: deleted.id }));
      } catch (err) {
        const status = err.message.includes("not found") ? 404 : 400;
        return server.json(res, status, fail("DELETE_ERROR", err.message));
      }
    }
  }

  return server.json(
    res,
    404,
    fail("NOT_FOUND", `No webhook route for ${method} ${pathname}`)
  );
}

module.exports = {
  handleWebhookRoute,
};
