# File Server Improvements – TODO

## Security (High Priority)

- [ ] Implement `isInvalidPath(path: string): boolean`
  - Reject paths containing `../` or `..\\`
  - Reject absolute paths
  - Ensure resolved paths stay within the allowed base directory
  - Apply to all file read/write operations

- [ ] Enforce file upload size limit
  - Maximum size: 10MB
  - Use Zod validation in `uploadFileHandler`
  - Return a clear validation error on failure

- [ ] Sanitize file names before rendering
  - Escape file names in `c.render`
  - Prevent XSS from uploaded or existing file names
  - Prefer a shared escaping utility

---

## Performance (Medium Priority)

- [ ] Optimize `GET /` directory listing
  - Use `readdir(path, { withFileTypes: true })`
  - Avoid repeated `fs.stat` calls
  - Use `Dirent` to distinguish files and directories

---

## Code Structure and Maintainability (Medium Priority)

- [ ] Add missing imports
  - `env`
  - `fsStat`
  - `readdir`
  - `readFile`
  - `path`
  - `mime`

- [ ] Add centralized error handling
  - Create a common error-handling middleware
  - Register with Hono `app.use()`
  - Standardize error response format

---

## Code Organization (Low Priority)

- [ ] Extract JSX/HTML from route handlers
  - Move templates to separate files (e.g., `index.tsx`)
  - Keep route handlers logic-only

---

## MIME Type Detection (Low Priority)

- [ ] Replace `mime.lookup`
  - Use `mime-types` or `file-type`
  - Prefer content-based detection when possible
