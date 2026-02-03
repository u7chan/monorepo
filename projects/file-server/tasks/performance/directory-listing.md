# Directory Listing Optimization

**Priority:** Medium  
**Category:** Performance

## Task

Optimize `GET /` directory listing

## Requirements

- Use `readdir(path, { withFileTypes: true })`
- Avoid repeated `fs.stat` calls
- Use `Dirent` to distinguish files and directories

## Acceptance Criteria

- [ ] Refactored to use `withFileTypes: true`
- [ ] Removed redundant `fs.stat` calls
- [ ] Performance benchmark showing improvement
