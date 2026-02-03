# Path Validation

**Priority:** High
**Category:** Security

## Task

Implement `isInvalidPath(path: string): boolean`

## Requirements

- Reject paths containing `../` or `..\`
- Reject absolute paths
- Ensure resolved paths stay within the allowed base directory
- Apply to all file read/write operations

## Acceptance Criteria

- [ ] Function implemented and tested
- [ ] Applied to all file read operations
- [ ] Applied to all file write operations
- [ ] Unit tests for edge cases (path traversal attempts)
