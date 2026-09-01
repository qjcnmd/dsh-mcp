# Requirements Checklist

- [x] Public tool names are explicit and finite.
- [x] The registry test rejects missing or additional tools.
- [x] Every mutation has an explicit target schema.
- [x] Send and wait are separate operations.
- [x] Wait is event-driven and request cancellation does not cancel DSH.
- [x] Human-input requests retain their exact DSH interaction identity.
- [x] Results are bounded and redact secret-bearing fields.
- [x] The MCP server does not manage the DSH process.
- [x] Browser state is not an execution dependency.
- [ ] Isolated live validation has passed against the current local DSH instance.
- [ ] User-level global registration has been verified.
