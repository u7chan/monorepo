# XSS Prevention - Filename Sanitization

**Priority:** High  
**Category:** Security

## Task

Sanitize file names before rendering

## Requirements

- Use hono/html or hono/jsx for auto-escaping
- Prevent XSS from uploaded or existing file names
- Add CSP headers as defense-in-depth

## Acceptance Criteria

- [ ] Filename escaping implemented in templates
- [ ] CSP headers added to responses
- [ ] Test with malicious filenames containing HTML/JS
