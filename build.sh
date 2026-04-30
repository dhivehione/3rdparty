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
    if git rev-parse --verify origin/main >/dev/null 2>&1; then
        # Check if ahead of remote
        AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "0")
        if [ "$AHEAD" -gt 0 ]; then
            echo "Pushing $AHEAD commit(s) to GitHub..."
            git push 2>&1 || {
                echo "WARNING: GitHub push failed."
                echo "To fix, update your remote with a token:"
                echo "  git remote set-url origin https://GITHUB_TOKEN@github.com/dhivehione/3rdparty.git"
            }
        else
            echo "Branch is up-to-date with remote."
        fi
    else
        echo "No remote configured. Run: git remote add origin <your-github-repo-url>"
    fi
fi

echo ""
TAG="${1:-latest}"

echo "Building Docker image: $IMAGE_NAME:$TAG"

# Build the Docker image
docker build -t $IMAGE_NAME:$TAG .

# Tag as latest if not already
docker tag $IMAGE_NAME:$TAG $IMAGE_NAME:latest

echo "Pushing to Docker Hub..."

# Push to Docker Hub
docker push $IMAGE_NAME:$TAG
docker push $IMAGE_NAME:latest

echo "Done! Image pushed: $IMAGE_NAME:$TAG"
echo "In CapRover, use image name: $IMAGE_NAME:$TAG"
