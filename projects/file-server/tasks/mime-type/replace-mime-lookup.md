# Replace mime.lookup

**Priority:** Low  
**Category:** MIME Type Detection

## Task

Replace `mime.lookup`

## Requirements

- Use `mime-types` or `file-type`
- Prefer content-based detection when possible

## Acceptance Criteria

- [ ] `mime.lookup` replaced with modern alternative
- [ ] Content-based detection working for binary files
- [ ] Extension-based fallback for text files
- [ ] All MIME types correctly detected
