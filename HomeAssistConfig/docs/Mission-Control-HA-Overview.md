---
marp: true
title: Mission Control × Home Assistant
description: How Alleycat Mission Control uses Home Assistant concepts, and why we run on Proxmox
theme: default
paginate: true
size: 16:9
style: |
  section {
    font-family: "Segoe UI", system-ui, sans-serif;
    background: #0b1020;
    color: #e8eefc;
    font-size: 28px;
    padding: 48px 56px;
    box-sizing: border-box;
  }
  h1, h2, h3 { color: #7dffb3; font-weight: 700; margin: 0 0 0.45em; }
  h1 { font-size: 1.55em; }
  h2 { font-size: 1.2em; }
  h3 { font-size: 1.05em; color: #9dffic; }
  p, li { margin: 0.28em 0; line-height: 1.35; }
  ul, ol { margin: 0.35em 0 0.35em 1.1em; padding: 0; }
  a { color: #7ec8ff; }
  strong { color: #fff; }
  code { background: #151c33; color: #b8f5d0; padding: 0.05em 0.3em; border-radius: 4px; font-size: 0.9em; }
  pre {
    background: #151c33;
    color: #b8f5d0;
    font-size: 0.62em;
    line-height: 1.25;
    padding: 0.7em 0.9em;
    margin: 0.4em 0;
  }
  table {
    font-size: 0.78em;
    width: 100%;
    border-collapse: collapse;
    margin: 0.4em 0;
  }
  th, td {
    padding: 0.35em 0.55em;
    vertical-align: top;
    border: 1px solid #2a3a5c;
  }
  th { background: #1a2440; color: #7dffb3; }
  td { background: #12192e; }
  blockquote {
    border-left: 4px solid #7dffb3;
    background: #12192e;
    color: #c9d4f0;
    margin: 0.5em 0;
    padding: 0.45em 0.75em;
    font-size: 0.92em;
  }
  section.title {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  section.title h1 { font-size: 2.1em; }
  .muted { color: #9aa8c7; font-size: 0.85em; }
  .compact table { font-size: 0.72em; }
  .compact li { font-size: 0.95em; }
---

<!-- _class: title -->

# Mission Control × Home Assistant

### How Alleycat's venue control system is built

**Home Assistant concepts · Mission Control architecture · Proxmox**

<p class="muted">Internal overview · Alleycat Project Mission Control</p>

---

# Agenda

1. **What is Home Assistant?**
2. **Core HA terms** — Integrations, Devices, Entities, Areas, Automations, Apps
3. **What is Mission Control?**
4. **How they work together**
5. **Example** — FDNs tracked through DNN entities
6. **Why Proxmox**
7. **Takeaways**

---

# What is Home Assistant?

Home Assistant (HA) is an **open-source automation platform** — a central hub that:

- Connects hardware and software through **integrations**
- Represents real-world things as **devices** and **entities**
- Tracks **state** (on/off, online/offline, sensor values, …)
- Runs **automations** when something changes
- Provides dashboards and operator UI

> For Alleycat, HA is the **control plane** for a live immersive venue — not hobby smart-home software.

---

# What is Mission Control?

**Mission Control** = Alleycat’s **operator console**, built by customizing Home Assistant:

- Alleycat theme + custom sidebar panels
- Four domain **integrations** for venue systems
- LAN backends for players, TV content, and bounty posters
- Edge hardware (ESP32 nodes, Raspberry Pi displays)

---

# Mission Control surfaces

| Operator need | Mission Control surface |
|---|---|
| Player roster | Registration panel |
| ESP32 venue nodes | Digital Node Nexus (DNN) |
| Zone video / signage | AlleycatTV + Content Manager |
| Wanted posters | Galactic Bounty Network |

---

# The big picture

```
              PROXMOX HOST
  ┌─────────────┬─────────────┬─────────────┐
  │ Home Assist │ AlleycatTV  │   Bounty    │
  │ Mission Ctrl│ Server LXC  │   Server    │
  │ + MQTT      │             │             │
  └──────┬──────┴──────┬──────┴──────┬──────┘
         │             │             │
    ESP32 FDNs    Raspberry Pis   Photobooth /
    LEDs/haptic    TV clients     intake devices
```

- **HA** = brains & operator UI
- **Proxmox** = hosts HA + companion services
- **Edge devices** = the venue floor

---

# Home Assistant building blocks (1/2)

| Concept | One-line meaning |
|---|---|
| **Integration** | Software that connects HA to another system |
| **Device** | Logical unit that groups related entities |
| **Entity** | One trackable thing (sensor, light, switch, …) |
| **State** | The current value of an entity |
| **Area** | Physical location grouping (room / zone) |

---

# Home Assistant building blocks (2/2)

| Concept | One-line meaning |
|---|---|
| **Automation** | Trigger → optional conditions → actions |
| **Script** | Reusable action sequence (no trigger) |
| **Scene** | Saved multi-device preset |
| **App** | Add-on that runs *alongside* HA (HAOS only) |

Source: [HA Concepts & terminology](https://www.home-assistant.io/getting-started/concepts-terminology/)

---

# Integrations vs Apps

| Integration | App (Add-on) |
|---|---|
| Connects HA **to** other software/hardware | Separate program that runs *next to* HA |
| Lives *inside* HA’s process model | Only on **Home Assistant OS** (Supervisor) |
| Creates devices & entities | Installed from Settings → Apps |
| Ex: Philips Hue, MQTT, **DNN** | Ex: Mosquitto broker, File editor |

Easy to confuse — they solve different problems.

---

# Mission Control rule of thumb

- Our custom venue logic → **Integrations** + **panels**
- Supporting services HA needs (e.g. MQTT) → often an **App**
- Our own backends (AlleycatTV, Bounty, Player API) → **not** HA Apps

Those backends run as **separate Proxmox services**.

---

# Devices vs Entities vs State

| Device | Entity |
|---|---|
| A **logical grouping** — one physical or logical unit | The **basic data unit** HA stores and watches |
| One FDN device may group: LED, online, RSSI, uptime | Has an ID like `light.lobby_node_led` |
| One device → many related entities | Exactly one **state** at a time + optional **attributes** |

> **Entities** are how Mission Control “sees” the venue in real time.

---

# Areas & Automations

| Areas | Automations |
|---|---|
| Map to **physical places** (lobby, dance floor, …) | **When X happens → do Y** |
| Devices get assigned to areas | 1. **Trigger** — starts it |
| Target a whole location at once | 2. **Condition** — optional gate |
| | 3. **Action** — what to do |

---

# Scripts & Scenes

| Tool | Difference |
|---|---|
| **Script** | Same actions as an automation, but **no trigger** — run on demand or from another automation |
| **Scene** | Snapshot of desired states (lights dimmed, TV on, …) applied together |

---

# Mission Control’s four integrations

| Integration | Connects to | Creates in HA |
|---|---|---|
| **Registration** | Player API | Roster sensors + panel |
| **Digital Node Nexus** | ESP32 **FDNs** (MQTT) | Lights, online, telemetry |
| **AlleycatTV** | Pis + content server | Media players + sensors |
| **Bounty** | Bounty Network server | Poster workflow + panel |

Custom Alleycat integrations — not stock smart-home plugins.

---

# How we use HA terms (1/2)

| HA term | How we use it |
|---|---|
| **Integration** | Bridge to a venue subsystem (DNN, TV, Registration, Bounty) |
| **Device** | One FDN, one Pi TV client, or a logical service unit |
| **Entity** | Live state we can show, automate, or command |
| **Attributes** | Extra context — e.g. `broadcast_zone` on an FDN LED |
| **Area** | Physical venue location for placement |

---

# How we use HA terms (2/2)

| HA term | How we use it |
|---|---|
| **Broadcast zone** *(ours)* | AlleycatTV content/group ID shared across FDNs & Pis |
| **Automation** | Keep related hardware in sync (e.g. FDN LEDs in a zone) |
| **Custom panel** | Operator UI in the sidebar *(not* an HA App) |
| **App** | Supporting HAOS add-ons (often MQTT / tooling) |
| **Service** | Callable command (`set_led`, `play_zone`, …) |

---

# Spotlight: DNN + FDN

### Digital Node Nexus (DNN)
Mission Control **integration + panel** that discovers, monitors, and commands ESP32 venue nodes.

### FDN
**Physical edge node** on the floor (ESP32): LEDs, haptic, optional display — managed by DNN.

> We use **entities** to track the current state of each FDN through DNN.

---

# How FDN state is tracked

1. FDN publishes status over **MQTT** (protobuf), on a cadence and on change
2. DNN receives it and updates the HA **device / entities**
3. Operators see live state in the DNN panel and entity list
4. Commands go the other way: panel/service → MQTT → FDN

Online/offline, LED color, RSSI, uptime, placement — all become HA state.

---

# FDN entity model

One FDN device typically exposes:

| Entity type | What it represents |
|---|---|
| `light.*` | LED output (RGB) + attributes like `broadcast_zone` |
| `binary_sensor.*` | Online / connectivity |
| `sensor.*` | RSSI, uptime, IP, firmware, free heap |

---

# FDN placement workflow

1. Create **HA Areas** for physical locations
2. Create **AlleycatTV broadcast zones** in Content Manager
3. Assign FDN placement in **DNN → Placement** (area + broadcast zone)
4. Automations can sync LEDs that share the same `broadcast_zone`

That is HA’s device / entity / area model applied to venue hardware.

---

# AlleycatTV (same pattern)

- Integration creates `media_player` + sensors per Pi
- Zones group displays for content
- Content Manager panel handles uploads / playlists
- MQTT + HTTP to Pis and the Proxmox LXC server

---

# Registration & Bounty (same pattern)

- Registration talks HTTP to the Player API
- Roster count / attributes become entities
- Bounty server hosts poster capture/display
- Future: FDN reads **PDN** (player tag) MAC → intake API

**Common pattern:** integration connects → devices/entities appear → panels & automations operate on live state.

---

# Transport: MQTT

Mission Control relies heavily on **local MQTT**:

- FDNs publish retained status (`esp32/{id}/status`)
- AlleycatTV Pis publish status and receive zone/player commands
- Empty Last Will (LWT) → device marked offline
- Commands are typed messages (protobuf), not ad-hoc strings

---

# Transport: HTTP

HTTP where request/response APIs fit better:

- Player roster / health
- AlleycatTV content & zones API
- Bounty poster services

HA sits in the middle as the **shared state and operator interface**.

---

# Why Proxmox?

Mission Control is **more than a single Home Assistant box**. We need:

- Home Assistant as the operator hub
- Our own long-running services (AlleycatTV, Bounty, Player API, …)
- Clear isolation when something breaks
- Room to grow without stuffing everything into one appliance

**Proxmox** lets us run HA **and** those companion services as separate VMs / LXC containers.

---

# Why not “just Docker”?

| Approach | Good for | Limitation for us |
|---|---|---|
| **HA Container** | Lightweight HA Core | **No Supervisor Apps** the same way |
| **HAOS** | Full HA + Apps | Appliance OS — **not** a host for our venue apps |
| **Proxmox + guests** | Full stack | HA where it belongs + our apps as own guests |

---

# Main reason we use Proxmox

> HAOS is not a Docker host for Alleycat’s applications.

We need Mission Control’s own services (AlleycatTV, Bounty, APIs) as **first-class workloads**, managed separately from HA.

Proxmox is how we get **HA + our apps** without fighting the appliance model.

---

# Proxmox ops benefits (1/2)

1. **Separated containers / VMs** — reboot AlleycatTV without taking down HA
2. **Faster troubleshooting** — logs and failures stay scoped to one guest
3. **Snapshots & rollback** — restore a known-good guest after a bad deploy
4. **Resource control** — pin CPU/RAM so media spikes don’t starve HA

---

# Proxmox ops benefits (2/2)

5. **Network clarity** — each service gets a stable LAN identity HA can reach
6. **Scale-out path** — add Pis, content LXCs, or API hosts without redesigning HA
7. **Matches our deploy docs** — AlleycatTV provisioning is a Proxmox LXC flow

Isolation means an AlleycatTV issue is an AlleycatTV reboot — not a full venue outage.

---

# Example guest layout

| Guest / service | Role |
|---|---|
| **Home Assistant** | Operator UI, entities, automations, integrations |
| **MQTT broker** | Message bus for FDNs and TV Pis |
| **AlleycatTV LXC** | Content API, zones, playlists, media |
| **Bounty server** | Poster capture, display, intake APIs |
| **Player API** | Roster backend (stub → Rust Central later) |
| **Edge (off Proxmox)** | ESP32 FDNs, Pi TV clients, photobooth |

---

# End-to-end story

1. **Proxmox** hosts HA and companion services as separate guests
2. **Home Assistant** provides the vocabulary: integrations, devices, entities, areas
3. **Mission Control integrations** map venue systems into that vocabulary
4. **Entities** hold live state — e.g. each **FDN** tracked by **DNN**

---

# End-to-end story (cont.)

5. **Areas + broadcast zones** align physical space with content zones
6. **Panels** give operators a purpose-built Alleycat UI on top of HA
7. **Automations / services** turn state changes into venue behavior

**System =** HA concepts + Alleycat domain logic + Proxmox isolation

---

# Glossary (1/2)

| Term | Meaning here |
|---|---|
| **HA** | Home Assistant — automation hub / control plane |
| **Mission Control** | Alleycat operator console built on HA |
| **Integration** | Connector that creates devices/entities |
| **App** | HAOS add-on running beside HA |
| **Device** | Group of related entities |
| **Entity / State** | One live value HA tracks |

---

# Glossary (2/2)

| Term | Meaning here |
|---|---|
| **DNN** | Digital Node Nexus — FDN control plane in HA |
| **FDN** | Physical ESP32 venue node managed by DNN |
| **PDN** | Player device/tag (MAC) — future intake path |
| **Broadcast zone** | AlleycatTV content grouping shared with FDNs |
| **Proxmox** | Host platform for HA + separated venue services |

---

# Takeaways

- **HA** gives us a proven model for devices, state, and automation
- **Mission Control** applies that model to a live venue
- Learn the HA vocabulary once — every Alleycat subsystem uses it
- **Entities** are the heartbeat: DNN tracks each FDN’s live state
- **Proxmox** exists because HAOS isn’t our app platform

Questions?

---

# Appendix — links & repo map

- HA concepts: https://www.home-assistant.io/getting-started/concepts-terminology/
- Package root: `HomeAssistConfig/`
  - `Config/` — HA YAML, theme, automations
  - `digital_node_nexus/` — DNN integration + firmware
  - `ProjectAlleycatTV/` — TV server, Pi client, integration
  - `registration/` / `ProjectBounty/` — roster + bounty

<p class="muted">Present with the Marp extension, or export to PDF / PPTX / HTML via Marp CLI.</p>
