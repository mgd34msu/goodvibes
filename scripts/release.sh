#!/bin/bash

# =============================================================================
# GoodVibes Release Script
# =============================================================================
# Usage:
#   ./scripts/release.sh          # patch bump (1.0.0 -> 1.0.1)
#   ./scripts/release.sh patch    # patch bump (1.0.0 -> 1.0.1)
#   ./scripts/release.sh minor    # minor bump (1.0.0 -> 1.1.0)
#   ./scripts/release.sh major    # major bump (1.0.0 -> 2.0.0)
#   ./scripts/release.sh --dry-run          # preview patch bump
#   ./scripts/release.sh minor --dry-run    # preview minor bump
#   ./scripts/release.sh --no-git           # skip git commit/tag
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_JSON="$PROJECT_ROOT/package.json"

# Parse arguments
BUMP_TYPE="patch"
DRY_RUN=false
NO_GIT=false

for arg in "$@"; do
  case $arg in
    major|minor|patch)
      BUMP_TYPE="$arg"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --no-git)
      NO_GIT=true
      ;;
    --help|-h)
      echo "Usage: $0 [major|minor|patch] [--dry-run] [--no-git]"
      echo ""
      echo "  patch (default)  Increment patch version: 1.0.0 -> 1.0.1"
      echo "  minor            Increment minor version: 1.0.0 -> 1.1.0"
      echo "  major            Increment major version: 1.0.0 -> 2.0.0"
      echo "  --dry-run        Preview changes without modifying files"
      echo "  --no-git         Skip git commit and tag"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Get current version from package.json
CURRENT_VERSION=$(grep '"version":' "$PACKAGE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [[ ! $CURRENT_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Could not parse version from package.json (got: $CURRENT_VERSION)"
  exit 1
fi

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate new version
case $BUMP_TYPE in
  major)
    NEW_MAJOR=$((MAJOR + 1))
    NEW_MINOR=0
    NEW_PATCH=0
    ;;
  minor)
    NEW_MAJOR=$MAJOR
    NEW_MINOR=$((MINOR + 1))
    NEW_PATCH=0
    ;;
  patch)
    NEW_MAJOR=$MAJOR
    NEW_MINOR=$MINOR
    NEW_PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="$NEW_MAJOR.$NEW_MINOR.$NEW_PATCH"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GoodVibes Release"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Bump type:       $BUMP_TYPE"
echo "  Current version: $CURRENT_VERSION"
echo "  New version:     $NEW_VERSION"
echo ""

if $DRY_RUN; then
  echo "  [DRY RUN] No changes will be made"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

# Update package.json
echo "  Updating package.json..."
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

# Git operations
if ! $NO_GIT; then
  echo "  Committing version bump..."
  cd "$PROJECT_ROOT"
  git add package.json
  git commit -m "chore: bump version to $NEW_VERSION"
  
  echo "  Creating git tag v$NEW_VERSION..."
  git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
  
  echo "  Pushing to remote..."
  git push && git push --tags
fi

# Build
echo ""
echo "  Building all platforms..."
echo ""
cd "$PROJECT_ROOT"

# Archive old releases before building
OLD_RELEASES_DIR="$PROJECT_ROOT/release/old-releases"
if compgen -G "$PROJECT_ROOT/release/*.AppImage" > /dev/null 2>&1 || compgen -G "$PROJECT_ROOT/release/*.zip" > /dev/null 2>&1; then
  echo "  Archiving old releases..."
  mkdir -p "$OLD_RELEASES_DIR"
  for file in "$PROJECT_ROOT/release"/*.AppImage "$PROJECT_ROOT/release"/*.zip; do
    if [[ -f "$file" ]]; then
      mv -f "$file" "$OLD_RELEASES_DIR/"
      echo "    Moved: $(basename "$file")"
    fi
  done
  echo ""
fi

npm run package:all

# Create Windows portable zip from win-unpacked directory
echo "  Creating Windows portable zip..."
WIN_UNPACKED="$PROJECT_ROOT/release/win-unpacked"
if [[ -d "$WIN_UNPACKED" ]]; then
  WIN_ZIP="$PROJECT_ROOT/release/GoodVibes-$NEW_VERSION-win-portable.zip"
  cd "$PROJECT_ROOT/release"
  # Rename to GoodVibes for clean zip structure
  mv win-unpacked GoodVibes
  zip -r "$WIN_ZIP" GoodVibes
  # Restore original name
  mv GoodVibes win-unpacked
  cd "$PROJECT_ROOT"
  echo "  Created: $(basename "$WIN_ZIP")"
else
  echo "  WARNING: win-unpacked directory not found"
fi

# Create GitHub release with assets
if ! $NO_GIT; then
  echo ""
  echo "  Creating GitHub release..."
  
  # Check if gh is installed
  if ! command -v gh &> /dev/null; then
    echo "  WARNING: gh CLI not installed. Skipping GitHub release."
    echo "  Install with: sudo pacman -S github-cli  (or your package manager)"
    echo "  Then run: gh auth login"
  else
    # Find release assets
    RELEASE_DIR="$PROJECT_ROOT/release"
    ASSETS=()
    
    # Add release files (AppImage + zips only, no raw exe)
    for file in "$RELEASE_DIR"/*.AppImage "$RELEASE_DIR"/*.zip; do
      if [[ -f "$file" ]]; then
        ASSETS+=("$file")
      fi
    done
    
    if [[ ${#ASSETS[@]} -eq 0 ]]; then
      echo "  WARNING: No release assets found in $RELEASE_DIR"
    else
      echo "  Generating release notes with Claude..."
      
      # Get previous tag
      PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
      
      # Gather context for Claude
      if [[ -n "$PREV_TAG" ]]; then
        COMMIT_LOG=$(git log --oneline "$PREV_TAG"..HEAD 2>/dev/null)
        DIFF_STAT=$(git diff --stat "$PREV_TAG"..HEAD 2>/dev/null | tail -20)
        CHANGED_FILES=$(git diff --name-only "$PREV_TAG"..HEAD 2>/dev/null)
      else
        COMMIT_LOG=$(git log --oneline -20 2>/dev/null)
        DIFF_STAT=$(git diff --stat HEAD~20..HEAD 2>/dev/null | tail -20)
        CHANGED_FILES=$(git diff --name-only HEAD~20..HEAD 2>/dev/null)
      fi
      
      # Build the prompt
      RELEASE_PROMPT="Generate release notes for GoodVibes v$NEW_VERSION.

Previous version: ${PREV_TAG:-"(first release)"}
New version: v$NEW_VERSION
Bump type: $BUMP_TYPE

## Recent commits:
$COMMIT_LOG

## Files changed:
$CHANGED_FILES

## Diff stats:
$DIFF_STAT

Write professional release notes in markdown with these sections:
1. Summary (2-3 sentences)
2. What's New (features, improvements)
3. Bug Fixes (if any)
4. Breaking Changes (if any, otherwise omit)
5. Upgrade Notes (brief instructions)

Be concise but informative. Focus on user-facing changes."

      # Generate notes with Claude CLI
      RELEASE_NOTES=$(echo "$RELEASE_PROMPT" | claude --print 2>/dev/null || echo "")
      
      if [[ -z "$RELEASE_NOTES" ]]; then
        echo "  Claude generation failed, using auto-generated notes"
        gh release create "v$NEW_VERSION" \
          --title "GoodVibes v$NEW_VERSION" \
          --generate-notes \
          "${ASSETS[@]}"
      else
        echo "  Uploading ${#ASSETS[@]} assets with Claude-generated notes..."
        gh release create "v$NEW_VERSION" \
          --title "GoodVibes v$NEW_VERSION" \
          --notes "$RELEASE_NOTES" \
          "${ASSETS[@]}"
      fi
      
      echo "  GitHub release created!"
    fi
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Release v$NEW_VERSION complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Output files in: $PROJECT_ROOT/release/"
echo ""
ls -lh "$PROJECT_ROOT/release/" 2>/dev/null || echo "  (release directory not found)"
echo ""
