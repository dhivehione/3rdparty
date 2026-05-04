#!/bin/bash

# Build and push Docker image to Docker Hub
# Usage: ./build.sh [tag]
# Example: ./build.sh v1.0

set -e

IMAGE_NAME="dhimarketer/3rdparty"

echo "Committing and pushing to GitHub..."

# Check if there are changes to commit
if git diff --quiet --cached && git diff --quiet; then
    echo "No changes to commit."
else
    git add -A
    git commit -m "Update $(date '+%Y-%m-%d %H:%M:%S')"
fi

# Push to remote if there are commits
LOCAL_COMMITS=$(git rev-list --count HEAD)
if [ "$LOCAL_COMMITS" -gt 0 ]; then
    # Check if remote exists
    BRANCH=$(git branch --show-current)
    if git rev-parse --verify origin/$BRANCH >/dev/null 2>&1; then
        # Check if ahead of remote
        AHEAD=$(git rev-list --count origin/$BRANCH..HEAD 2>/dev/null || echo "0")
        if [ "$AHEAD" -gt 0 ]; then
            echo "Pushing $AHEAD commit(s) to GitHub..."
            git push 2>&1 || {
                echo "WARNING: GitHub push failed."
                echo "To fix, add your GitHub token to git remote:"
                echo "  git remote set-url origin https://YOUR_TOKEN@github.com/user/repo.git"
            }
        else
            echo "Branch is up-to-date with remote."
        fi
    else
        echo "No remote configured. Run: git remote add origin <your-github-repo-url>"
    fi
fi

echo ""
# Auto-generate version if not provided
COMMIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "dev")
if [ -z "$1" ]; then
    # Use commit hash + date for version
    TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
    TAG="$COMMIT_SHORT-$TIMESTAMP"
    echo "Auto-generated version: $TAG"
else
    TAG="$1"
fi

# Create version file for container
echo "VERSION=$TAG" > version.txt
echo "COMMIT=$COMMIT_HASH" >> version.txt
echo "BUILT=$(date '+%Y-%m-%d %H:%M:%S')" >> version.txt
echo "Created version.txt"

echo "Building Docker image: $IMAGE_NAME:$TAG"

# Build with BuildKit (uses Docker's built-in layer caching)
DOCKER_BUILDKIT=1 docker build -t $IMAGE_NAME:$TAG .

# Tag as latest if not already
docker tag $IMAGE_NAME:$TAG $IMAGE_NAME:latest

echo "Pushing to Docker Hub..."

# Push to Docker Hub
docker push $IMAGE_NAME:$TAG
docker push $IMAGE_NAME:latest

echo "Done! Image pushed: $IMAGE_NAME:$TAG"
echo "Also available as: $IMAGE_NAME:latest"
echo ""
echo "CapRover deployment options:"
echo "  - Use '$IMAGE_NAME:$TAG' for specific version"
echo "  - Use '$IMAGE_NAME:latest' for always-latest"
echo ""
echo "NOTE: Database migration is handled automatically when the server starts."
echo "The migration code in server.js will add any missing columns."
