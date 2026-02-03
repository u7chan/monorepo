# Upload Size Limit

**Priority:** High  
**Category:** Security

## Task

Enforce file upload size limit

## Requirements

- Maximum size: 10MB
- Use Zod validation in `uploadFileHandler`
- Return a clear validation error on failure

## Acceptance Criteria

- [ ] Zod schema updated with size limit validation
- [ ] Clear error message returned on oversized uploads
- [ ] Test with files >10MB
