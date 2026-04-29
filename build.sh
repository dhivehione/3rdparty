#!/bin/bash

# Build and push Docker image to Docker Hub
# Usage: ./build.sh [tag]
# Example: ./build.sh v1.0

set -e

IMAGE_NAME="dhimarketer/3rdparty"
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
