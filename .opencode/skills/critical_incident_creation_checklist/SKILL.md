---
name: critical_incident_creation_checklist
description: "Skill critical_incident_creation_checklist. Use when the task matches its domain."
---

# ITSM Critical Incident Creation Checklist

This document provides an explicit, step-by-step checklist for creating a top-severity service incident and alerting the assignee. Every field and step listed here is **REQUIRED** for successful completion. Do not infer field values; follow this checklist precisely to ensure all verifier conditions are met.

## Intent

Create a top-severity service incident for a named caller and their owned hardware, hand it to a named responder, move it into active work, and queue an alert to that responder.

## Ordered Procedure Checklist (Perform these steps in order)

Before replying DONE, ensure each of these steps has been completed:

*   [ ] **Step 1: Resolve the Caller.**
    *   Look up the user by the caller's first and last name to get their `user id`.
*   [ ] **Step 2: Resolve the Assignee/Responder.**
    *   Look up the user by the responder's first and last name to get their `user id` and `email`.
*   [ ] **Step 3: Find the Caller's Configuration Item.**
    *   List the caller's owned configuration items with status `in_use`.
    *   Identify the item that is hardware (name / short_description / category contains "laptop", "desktop", or "hardware").
    *   If no `in_use` hardware is found, fall back to any owned item. Obtain its `id`.
*   [ ] **Step 4: Find the Service.**
    *   Look up the service by its exact name to get its `id`.
*   [ ] **Step 5: Create the Incident.**
    *   Use the `create_incident` tool with *all* the fields specified in the "Incident Field Set Checklist" below. This is a common point of failure if fields are omitted.
*   [ ] **Step 6: Update the Incident Status.**
    *   Immediately after creation, update the incident's status to `in_progress` to reflect active work.
*   [ ] **Step 7: Send the Alert Notification.**
    *   Send an alert notification to the assignee using *all* the fields specified in the "Alert Notification Field Set Checklist" below.

## Incident Field Set Checklist (for `create_incident` — ALL are REQUIRED)

When calling `create_incident`, ensure every one of these fields is explicitly set to its correct value. Omitting any of these will result in a score of 0.

*   [ ] `caller_id`: Set to the resolved caller's user id.
*   [ ] `assigned_to`: Set to the resolved responder's user id.
*   [ ] `service`: Set to the resolved service's id.
*   [ ] `configuration_item`: Set to the caller's identified hardware configuration item id.
*   [ ] `channel`: **MUST be set to `virtual-agent`**.
*   [ ] `status`: **MUST be set to `in_progress`**.
*   [ ] `impact`: **MUST be set to `high`**.
*   [ ] `urgency`: **MUST be set to `high`**.
*   [ ] `priority`: **MUST be set to `critical`** (this is derived from `impact=high` and `urgency=high`).
*   [ ] `category`: **CRITICAL: MUST be set to `hardware` explicitly.** This field is often implicit in prompts but is absolutely required by verifiers.

## Alert Notification Field Set Checklist (for `send_notification`)

After creating the incident, send a notification to the assignee with these fields:

*   [ ] `incident_id`: Set to the id returned by the `create_incident` call.
*   [ ] `email`: Set to the assignee's email address.
*   [ ] `type`: **MUST be set to `alert`**.
*   [ ] `status`: **MUST be set to `queued`**.
*   [ ] `subject`: Include the caller's name, the service name, and mention the slowdown.
*   [ ] `message`: Include the caller's name, the service name, and describe the slowdown.

## Before Replying DONE

Ensure *all* items in the "Ordered Procedure Checklist", "Incident Field Set Checklist", and "Alert Notification Field Set Checklist" have been completed and set exactly as specified.
