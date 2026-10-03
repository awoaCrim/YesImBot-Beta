# Chihaya Anon prompt example

This is an opt-in **local reference draft**, based on the previously reviewed Anon staging material. It is not a snapshot of the current production configuration and is not loaded automatically.

- `PERSONA.md` is the primary editable character document: identity, stage, motivations, relationships, reactions and voice.
- `card-fields.json` contains supplementary character-card **fields**, not a complete importable card. It keeps background, scenario and the existing short dialogue examples. Repeated personality, system and post-history paragraphs are intentionally empty.
- Runtime delivery, evidence boundaries, message attribution and tool syntax belong to Core and tools. Do not copy them into every card field.

## Applying intentionally

1. Read and back up your actual runtime `PERSONA.md` and PNG card. Compare their contents with this draft; preserve any additional custom settings you still need.
2. Merge the primary document into the configured Core `basePath/PERSONA.md`.
3. Use your character-card editor to merge the supplied fields into your existing card, preserving metadata, greeting settings and any other required fields, then export a valid PNG card. The Roleplay plugin accepts PNG cards, **not this JSON file**.
4. Keep Core's primary-persona/supplementary-card precedence in mind. If using a card without a custom Persona instead, put the complete character definition in the card; this deliberately minimal supplement is not a standalone full persona.
5. Recreate the affected runtime or restart the relevant service after reviewing the new files. Prompt files are not a per-turn hot-reload interface. Any production restart/deployment requires a separate approved operation.

No script here modifies production, copies files into runtime storage, imports the SillyTavern preset, or enables polishing. Behavioural quality still needs observation in representative conversations; structural tests do not prove a model will always stay in character.
