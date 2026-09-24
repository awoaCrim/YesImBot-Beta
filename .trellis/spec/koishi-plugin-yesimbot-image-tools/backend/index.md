# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [Image Edit Transport Contract](./transport-contract.md) | Active `/images/edits` JSON boundary and regression contract | Maintained |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

## Pre-Development Checklist

For changes to `plugins/image-tools` image transport:

- Read [Image Edit Transport Contract](./transport-contract.md) before editing the request body.
- Verify the active endpoint/model contract from a sanitized provider response or authoritative documentation; do not infer it from the generic OpenAI route name.
- Add or update a fixture that fails on the old request shape before applying the transport change.
- Keep source-resource validation, output validation, bounded errors, and artifact persistence separate from the wire-format change.
- Do not run a real image request as a substitute for the deterministic contract test unless quota-consuming activity is explicitly approved.

**Language**: All documentation should be written in **English**.
