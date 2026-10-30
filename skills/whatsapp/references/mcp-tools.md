# WhatsApp MCP Tools Reference

This document provides complete parameter schemas, constraints, return structures, and error codes for all 9 tools exposed by the WhatsApp Model Context Protocol (MCP) server.

All tools communicate locally with the background WhatsApp daemon over loopback HTTP and return structured JSON responses.

---

## 1. `whatsapp_get_status`

Inspects the WhatsApp daemon process, connection health, and authenticated user account.

### Input Schema
No arguments required (`{}`).

### Return Structure
```json
{
  "ok": true,
  "state": "ready",
  "account": {
    "number": "923124706501",
    "name": "User Name"
  },
  "lastError": null,
  "nodeVersion": "v20.18.0",
  "appVersion": "1.0.0"
}
```

### Possible States
- `ready`: Authenticated and ready to send/receive messages.
- `linking`: Waiting for QR code to be scanned via terminal (`wa login`).
- `initializing`: Daemon is booting Puppeteer and loading WhatsApp Web.
- `recovering`: Puppeteer frame detached or reloaded; daemon is auto-recovering.
- `logged_out`: Session was unlinked or logged out from device settings.

---

## 2. `whatsapp_list_chats`

Retrieves recent chat conversations sorted by most recent activity.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `limit` | integer | No | `50` | `1` to `200` | Maximum number of chats to return |

### Return Structure
```json
{
  "ok": true,
  "count": 2,
  "chats": [
    {
      "id": "15551234567@c.us",
      "name": "Alice Smith",
      "isGroup": false,
      "unreadCount": 0,
      "pinned": false,
      "archived": false,
      "timestamp": 1729000000,
      "lastMessage": {
        "body": "See you tomorrow!",
        "timestamp": 1729000000,
        "fromMe": false
      }
    }
  ]
}
```

---

## 3. `whatsapp_list_contacts`

Searches saved address book contacts and known chat participants.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `name` | string | No | `""` | Optional | Substring to filter contact names (case-insensitive) |

### Return Structure
```json
{
  "ok": true,
  "count": 1,
  "contacts": [
    {
      "id": "15551234567@c.us",
      "name": "Alice Smith",
      "pushname": "Alice",
      "number": "15551234567",
      "isMyContact": true,
      "isUser": true,
      "isGroup": false
    }
  ]
}
```

---

## 4. `whatsapp_get_chat_history`

Fetches recent message history for a specific individual contact, group, or self.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `target` | string | **Yes** | — | Non-empty | Phone number (e.g. `15551234567`), contact JID (`...@c.us`), group JID (`...@g.us`), or `'me'` |
| `limit` | integer | No | `50` | `1` to `200` | Maximum messages to fetch |

### Return Structure
```json
{
  "ok": true,
  "target": "15551234567@c.us",
  "count": 1,
  "messages": [
    {
      "id": "true_15551234567@c.us_3EB0...",
      "from": "me",
      "to": "15551234567@c.us",
      "author": null,
      "fromMe": true,
      "body": "Hello Alice!",
      "timestamp": 1729000010,
      "type": "chat",
      "ack": 2
    }
  ]
}
```

---

## 5. `whatsapp_send_message`

Sends a plain text message to a recipient.

### Input Schema
| Field | Type | Required | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- |
| `target` | string | **Yes** | Non-empty | Recipient phone number, contact JID, group JID, or `'me'` |
| `message` | string | **Yes** | 1 to 65,000 characters | Message body text to send |

### Return Structure
```json
{
  "ok": true,
  "messageId": "true_15551234567@c.us_3EB0C1A...",
  "to": "15551234567@c.us",
  "timestamp": 1729000020
}
```

---

## 6. `whatsapp_send_image`

Sends a photo or image file with an optional caption.

### Input Schema
| Field | Type | Required | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- |
| `target` | string | **Yes** | Non-empty | Recipient phone number, contact JID, group JID, or `'me'` |
| `filePath` | string | **Yes** | Valid regular file, <= 16 MB | Absolute or relative path to image file |
| `caption` | string | No | Optional text | Caption to accompany the image |

### Supported Image Formats
- JPEG (`.jpg`, `.jpeg`) — `image/jpeg`
- PNG (`.png`) — `image/png`
- WebP (`.webp`) — `image/webp`
- GIF (`.gif`) — `image/gif`
- BMP (`.bmp`) — `image/bmp`
- SVG (`.svg`) — `image/svg+xml`
- TIFF (`.tif`, `.tiff`) — `image/tiff`
- Icon (`.ico`) — `image/x-icon`

### Return Structure
```json
{
  "ok": true,
  "messageId": "true_15551234567@c.us_3EB0C1B...",
  "to": "15551234567@c.us",
  "filename": "chart.png",
  "mimetype": "image/png",
  "timestamp": 1729000030
}
```

---

## 7. `whatsapp_send_document`

Sends any file or document as a native WhatsApp attachment with original filename and MIME type.

### Input Schema
| Field | Type | Required | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- |
| `target` | string | **Yes** | Non-empty | Recipient phone number, contact JID, group JID, or `'me'` |
| `filePath` | string | **Yes** | Valid regular file, <= 100 MB | Absolute or relative path to document file |
| `filename` | string | No | Custom string | Optional display filename for recipient (defaults to original filename) |
| `caption` | string | No | Optional text | Optional caption |

### Return Structure
```json
{
  "ok": true,
  "messageId": "true_15551234567@c.us_3EB0C1C...",
  "to": "15551234567@c.us",
  "filename": "Q3_Financial_Report.pdf",
  "mimetype": "application/pdf",
  "timestamp": 1729000040
}
```

---

## 8. `whatsapp_mark_seen`

Marks messages in a given chat conversation as read/seen.

### Input Schema
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `target` | string | **Yes** | Recipient phone number, contact JID, or group JID to mark as read |

### Return Structure
```json
{
  "ok": true,
  "chatId": "15551234567@c.us"
}
```

---

## 9. `whatsapp_get_recent_messages`

Queries recent incoming WhatsApp messages cached in the daemon's in-memory ring buffer (up to 100 messages) received via Server-Sent Events (SSE).

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `limit` | integer | No | `20` | `1` to `100` | Maximum messages to return |
| `sinceTimestamp` | number | No | `null` | Unix timestamp | Only return messages received strictly after this timestamp |
| `chatId` | string | No | `null` | Optional target | Filter messages by contact number or chat JID |

### Return Structure
```json
{
  "ok": true,
  "bufferedTotal": 5,
  "count": 1,
  "messages": [
    {
      "id": "false_15551234567@c.us_3EB0...",
      "chatId": "15551234567@c.us",
      "from": "15551234567@c.us",
      "to": "923124706501@c.us",
      "fromMe": false,
      "author": null,
      "body": "Can you send the updated deck?",
      "timestamp": 1729000050
    }
  ]
}
```

---

## 10. `whatsapp_get_recent_media`

Retrieves recently received media attachments (images and documents) across conversations or filtered by a specific contact.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `chatId` | string | No | `null` | Phone number or JID | Filter media by contact number, `@c.us` JID, or group `@g.us` JID |
| `type` | string | No | `"all"` | `"all"`, `"image"`, `"document"` | Media type filter |
| `limit` | integer | No | `20` | `1` to `100` | Maximum number of media items to return |
| `sinceTimestamp` | number | No | `null` | Unix timestamp | Return media received after this timestamp in seconds |

### Return Structure
```json
{
  "ok": true,
  "count": 2,
  "media": [
    {
      "messageId": "false_15551234567@c.us_3EB0ABC123",
      "chatId": "15551234567@c.us",
      "from": "15551234567@c.us",
      "fromMe": false,
      "author": null,
      "timestamp": 1729000100,
      "type": "image",
      "mimetype": "image/jpeg",
      "filename": "photo.jpg",
      "caption": "Latest whiteboard notes",
      "filesize": 254100,
      "downloaded": true,
      "filePath": "/path/to/whatsapp-cli/.data/media/false_15551234567_c_us_3EB0ABC123_photo.jpg"
    }
  ]
}
```

---

## 11. `whatsapp_download_media`

Downloads an incoming media attachment from WhatsApp using its unique message ID, saving it locally to disk.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `messageId` | string | Yes | — | Min 5 chars | Serialized WhatsApp message ID containing media |
| `outputDir` | string | No | `.data/media` | Valid directory path | Optional custom directory to save attachment into |
| `filename` | string | No | Original name | Sanitized string | Optional custom filename override |

### Return Structure
```json
{
  "ok": true,
  "messageId": "false_15551234567@c.us_3EB0ABC123",
  "filePath": "/path/to/whatsapp-cli/.data/media/false_15551234567_c_us_3EB0ABC123_photo.jpg",
  "filename": "photo.jpg",
  "mimetype": "image/jpeg",
  "size": 254100,
  "caption": "Latest whiteboard notes",
  "cached": false
}
```

---

## 12. `whatsapp_get_media_info`

Retrieves attachment metadata for a WhatsApp message without downloading the full payload to disk.

### Input Schema
| Field | Type | Required | Default | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `messageId` | string | Yes | — | Min 5 chars | Serialized WhatsApp message ID to inspect |

### Return Structure
```json
{
  "ok": true,
  "media": {
    "messageId": "false_15551234567@c.us_3EB0DOC999",
    "chatId": "15551234567@c.us",
    "from": "15551234567@c.us",
    "type": "document",
    "mimetype": "application/pdf",
    "filename": "Proposal_Final.pdf",
    "filesize": 1048576,
    "caption": "Attached proposal",
    "timestamp": 1729000150,
    "downloaded": false,
    "filePath": null
  }
}
```

---

## Common Error Codes & Handling

| Error Code / Message | Cause | Corrective Action |
| :--- | :--- | :--- |
| `WhatsApp daemon is not reachable` | Daemon process is stopped or port is not responding. | Start daemon via `wa status` or run `wa daemon` in terminal. |
| `WhatsApp daemon is not ready yet` | Daemon is in `linking` or `initializing` state. | If linking, run `wa login` in terminal and scan QR code. |
| `Cannot resolve 'me'` | Daemon is not ready or user account info is missing. | Verify daemon readiness with `whatsapp_get_status`. |
| `File not found: "<path>"` | Provided path does not exist on disk. | Verify absolute or relative path exists before calling tool. |
| `Path is not a regular file` | Path points to a directory, FIFO, or socket. | Ensure target is a normal file. |
| `File is empty (0 bytes)` | File has zero size. | Provide a non-empty media file. |
| `File size exceeds the maximum allowed limit` | Image > 16 MB or Document > 100 MB. | Compress or downscale file, or send large images as documents. |
| `not a supported image format` | Unrecognized image extension/MIME. | Send file via `whatsapp_send_document` instead. |
| `File is not readable (permission denied)` | Process user lacks read permission (`R_OK`). | Check file filesystem permissions (`chmod +r`). |
