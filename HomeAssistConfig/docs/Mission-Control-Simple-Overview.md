---
marp: true
title: Mission Control — Simple Overview
description: A non-technical overview of Mission Control, Home Assistant, and Proxmox
theme: default
paginate: true
size: 16:9
style: |
  section {
    font-family: "Segoe UI", system-ui, sans-serif;
    background: #0b1020;
    color: #e8eefc;
    font-size: 30px;
    padding: 52px 60px;
    box-sizing: border-box;
  }
  h1, h2, h3 { color: #7dffb3; font-weight: 700; margin: 0 0 0.5em; }
  h1 { font-size: 1.55em; }
  h2 { font-size: 1.2em; }
  h3 { font-size: 1.05em; color: #9dffic; }
  p, li { margin: 0.32em 0; line-height: 1.4; }
  ul, ol { margin: 0.4em 0 0.4em 1.1em; padding: 0; }
  a { color: #7ec8ff; }
  strong { color: #fff; }
  table {
    font-size: 0.82em;
    width: 100%;
    border-collapse: collapse;
    margin: 0.5em 0;
  }
  th, td {
    padding: 0.4em 0.6em;
    vertical-align: top;
    border: 1px solid #2a3a5c;
  }
  th { background: #1a2440; color: #7dffb3; }
  td { background: #12192e; }
  blockquote {
    border-left: 4px solid #7dffb3;
    background: #12192e;
    color: #c9d4f0;
    margin: 0.55em 0;
    padding: 0.5em 0.8em;
    font-size: 0.95em;
  }
  section.title {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  section.title h1 { font-size: 2.1em; }
  .muted { color: #9aa8c7; font-size: 0.85em; }
---

<!-- _class: title -->

# Mission Control

### How Alleycat runs the venue from one place

**A simple overview for a wider audience**

<p class="muted">Companion to the technical deep-dive deck</p>

---

# What is Mission Control?

**Mission Control** is the **operator console** for Alleycat’s live venue.

From one screen, staff can:

- See who’s registered / on the roster
- Monitor floor devices (lights, nodes, displays)
- Control TVs and content by zone
- Run bounty / poster workflows

> Think of it as the **control room dashboard** for the experience.

---

# What is Home Assistant?

**Home Assistant** is open-source software built to connect many devices and systems into one place.

People often use it for smart homes.  
**We use it as the foundation for Mission Control.**

It already knows how to:

- Talk to many kinds of hardware and software
- Show live status
- Automate “when this happens, do that”

We customize it for Alleycat instead of building a control system from scratch.

---

# How they fit together

| Piece | Role (plain English) |
|---|---|
| **Home Assistant** | The engine / platform underneath |
| **Mission Control** | Our Alleycat-branded operator experience on top |
| **Venue devices** | Nodes, TVs, and tools on the floor |
| **Proxmox** | The computer host that runs the software safely apart |

**Mission Control is not a separate mystery app.**  
It *is* Home Assistant, shaped into Alleycat’s venue console.

---

# A few words you’ll hear

| Word | Simple meaning |
|---|---|
| **Integration** | A connector that lets Mission Control talk to a system |
| **Device** | One thing in the venue (a node, a TV player, …) |
| **Entity** | One live status or control for that thing |
| **App** | A helper program that runs beside Home Assistant |
| **Area** | A physical place (lobby, dance floor, queue, …) |

You don’t need the deep technical definitions — just that **connectors bring devices in**, and **live status** is what operators watch.

---

# Integrations vs Apps (quick distinction)

**Integration** = “plug this system into Mission Control”  
Creates the live statuses operators see and control.

**App** = “run a helper next to Home Assistant”  
Example: the message broker that devices use to check in.

Our Alleycat features (Registration, floor nodes, TVs, Bounty) are mainly **integrations** and custom panels — not generic store apps.

---

# What operators actually use

| Need | Where they go in Mission Control |
|---|---|
| Player roster / check-in | **Registration** |
| Floor nodes (lights, status) | **Digital Node Nexus** |
| Zone video & signage | **AlleycatTV** |
| Wanted posters | **Galactic Bounty Network** |

Each of those is wired into Home Assistant so everything shares the same live picture of the venue.

---

# Floor nodes, simply

**Digital Node Nexus** is the Mission Control panel for our floor hardware.

Those physical boxes on the floor (**FDNs**) can report things like:

- Are they online?
- What color is the light?
- Where are they placed?

Mission Control keeps that status up to date so staff can see problems and send commands without hunting through separate tools.

---

# TVs, registration, and bounty

Same idea across the venue:

- **AlleycatTV** — play content to groups of screens by zone
- **Registration** — who’s in the experience
- **Bounty** — poster capture and display

Different jobs, same pattern:  
**connect → show live status → let operators act.**

---

# Why we use Proxmox

Mission Control needs more than one program running:

- Home Assistant / Mission Control
- TV content server
- Bounty server
- Other supporting services

**Proxmox** is the host that runs those as **separate machines/containers** on the same hardware.

> Home Assistant is great as the console —  
> but it is **not** meant to host all of our custom Alleycat apps by itself.

---

# Why separation matters

Keeping services separate means:

- If the TV server needs a reboot, Mission Control can keep running
- Problems are easier to find (“it’s the bounty box,” not “the whole system”)
- We can update one piece without risking everything
- The venue can grow (more screens, more services) without redesigning the console

**Reliability and troubleshooting** are the everyday wins.

---

# The story in one slide

1. **Proxmox** hosts the software pieces separately  
2. **Home Assistant** gives us a proven way to connect devices and show live status  
3. **Mission Control** is our Alleycat operator console on that foundation  
4. Staff use panels for registration, floor nodes, TVs, and bounty  
5. Separated services keep the venue more resilient when something breaks  

---

# Takeaways

- Mission Control = **Alleycat’s control room**, built on Home Assistant
- Home Assistant gives us connections, live status, and automation for free
- Operators work in familiar Alleycat panels — not raw infrastructure
- Proxmox keeps our systems **isolated and restartable**

Questions?

---

# Want more detail?

A longer technical deck covers:

- Home Assistant terminology in depth
- How entities map to floor nodes and TVs
- Messaging between devices and Mission Control
- Guest/service layout on Proxmox

Ask for: **Mission Control × Home Assistant** (technical overview)
