#!/usr/bin/env bash

# Marks given URLs as checked in data/pipeline.md
# Usage: ./update_tracker.sh <url1> <url2> ...

FILE="/home/Aarz/career-ops/data/pipeline.md"

for url in "$@"; do
    # Escape special characters in url for sed
    ESCAPED_URL=$(echo "$url" | sed -e 's/[\/&]/\\&/g')
    
    # Replace "- [ ] url" with "- [x] url"
    sed -i "s/- \[ \] $ESCAPED_URL/- \[x\] $ESCAPED_URL/g" "$FILE"
done

echo "Updated tracker for $# URLs."
