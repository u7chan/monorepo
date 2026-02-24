---
name: dockerfile-designer
description: Activates when asked to create a Dockerfile or when working on a new project in the monorepo. Designs Dockerfiles that follow the monorepo's CI/CD conventions with proper test and final stages.
---

# Dockerfile Designer

## Overview

Designs Dockerfiles that comply with the monorepo's CI/CD pipeline requirements.
Ensures proper multi-stage builds with test and final stages for seamless integration with GitHub Actions.

## When to Use This Skill

- When told "create a Dockerfile" or "design a Dockerfile"
- When creating a new project in `projects/`
- When migrating an existing project to use the monorepo CI/CD
- When reviewing a Dockerfile for CI/CD compliance

## What the Agent Does

1. Check if the project is CI-only (test only) or full CI/CD (test + final)
2. Read the project structure and entry point
3. Design a multi-stage Dockerfile with appropriate stages
4. Include COMMIT_HASH build argument support
5. Add pre-docker-build.sh hook if needed
6. Validate the Dockerfile against CI/CD requirements

## Input and Output

**Input:**
- Project path (e.g., `projects/my-app/`)
- Project type (application, library, tool)
- Whether the project needs deployment (CI/CD) or just testing (CI-only)

**Output:**
- `Dockerfile` - Multi-stage build configuration
- `pre-docker-build.sh` (optional) - Pre-build hook script

## Step Details

### Step 1: Determine Project Type

Ask or determine:
- Does this project need to be deployed (requires final stage)?
- Is this a library/test tool that only needs validation (CI-only)?
- What is the runtime (Node.js, Python, Go, etc.)?

Project types:
| Type | CI Stage | CD Stage | Use Case |
|------|----------|----------|----------|
| CI-only | test | (none) | Libraries, test tools, validators |
| Full CI/CD | test | final | Applications, services, deployable tools |

**Important:** CD workflow uses `required-stage: final` filter. Projects without `final` stage are skipped during CD and no image is built or pushed.

### Step 2: Design the Dockerfile Structure

Create a Dockerfile with these required stages:

```dockerfile
# ---- base stage ----
FROM {base-image} AS base
WORKDIR /app
COPY package*.json ./  # or requirements.txt, go.mod, etc.
RUN install-dependencies

# ---- test stage (REQUIRED for CI) ----
FROM base AS test
COPY . .
RUN ./run-tests.sh

# ---- final stage (REQUIRED for CD) ----
FROM base AS final
COPY . .
CMD ["./start.sh"]
```

Required elements:
- `AS test` stage - CI builds with `--target=test`
- `AS final` stage - CD builds with `--target=final` (skip for CI-only)
- `COMMIT_HASH` build argument - passed by the CI/CD pipeline

### Step 3: Include COMMIT_HASH Build Argument

Add this to both test and final stages:

```dockerfile
ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
```

This enables version tracking in built images.

### Step 4: Add pre-docker-build.sh (Optional)

If the project needs build-time preparation:

1. Create `pre-docker-build.sh` in the project root
2. Make it executable: `chmod +x pre-docker-build.sh`
3. The CI/CD pipeline runs this before docker build automatically

Example use cases:
- Generate code from templates
- Build frontend assets
- Download external resources

### Step 5: Validate Against CI/CD Requirements

Checklist:
- [ ] Dockerfile exists in project root
- [ ] `test` stage exists (FROM ... AS test)
- [ ] `final` stage exists (for deployable projects)
- [ ] COMMIT_HASH is accepted as build argument
- [ ] File follows best practices (minimal layers, .dockerignore)

## Examples

### Example 1: CI-Only Project (Library/Test Tool)

Reference: `projects/cicd-ci-sample/Dockerfile`

    # CI専用 - testステージのみ
    FROM alpine:3.21 AS base

    ARG COMMIT_HASH=""

    WORKDIR /app

    FROM base AS test
    COPY scripts/ scripts/
    COPY tests/ tests/

    RUN chmod +x scripts/test.sh && \
        ./scripts/test.sh

    # finalステージはない - CI専用

### Example 2: Full CI/CD Project (Application)

Reference: `projects/cicd-cd-sample/Dockerfile`

    # CD用 - マルチステージビルド
    FROM alpine:3.21 AS base

    ARG COMMIT_HASH=""

    WORKDIR /app

    FROM base AS builder
    COPY src/ src/
    RUN mkdir -p dist && \
        cp src/* dist/

    FROM base AS final
    ARG COMMIT_HASH
    ENV APP_VERSION="${COMMIT_HASH}"
    COPY --from=builder /app/dist/ dist/
    CMD ["cat", "dist/build-info.txt"]

**Note:** For full CI/CD projects that need PR validation, add a `test` stage:

    FROM base AS test
    COPY . .
    RUN ./run-tests.sh

## Quality Check

- [ ] Dockerfile has `test` stage defined with `AS test`
- [ ] For CI/CD projects: `final` stage exists with `AS final`
- [ ] For full CI/CD: both `test` and `final` stages exist
- [ ] COMMIT_HASH build argument is handled
- [ ] Base stage is used to share layers between test and final
- [ ] Only necessary files are copied (use .dockerignore)
- [ ] Commands are ordered by change frequency (dependencies first)

## References

- `docs/about-cicd.md` - CI/CD documentation
- `projects/cicd-ci-sample/` - CI-only sample project
- `projects/cicd-cd-sample/` - CD sample project
