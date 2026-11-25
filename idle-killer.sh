#!/bin/bash
# Wait for Cockroach to start
sleep 10

while true; do
    # Get the current epoch time
    NOW=$(date +%s)
    
    # Get list of sessions in JSON format
    SESSIONS=$(curl -s http://127.0.0.1:43110/sessions 2>/dev/null)
    
    if [ ! -z "$SESSIONS" ] && [ "$SESSIONS" != "[]" ]; then
        # Parse JSON to find session IDs and their last active timestamps
        echo "$SESSIONS" | jq -r '.[] | "\(.id) \(.lastActivity)"' | while read -r ID LAST_ACTIVITY; do
            # If lastActivity isn't a standard epoch, we default to killing if needed
            # (Adjust logic based on exact Cockroach JSON output)
            # Here we just kill anything older than 60 minutes (3600 seconds)
            AGE=$((NOW - LAST_ACTIVITY))
            if [ "$AGE" -gt 3600 ]; then
                echo "Killing idle session: $ID (Idle for $AGE seconds)"
                npx cockroach-browser session close --id "$ID" >> /home/browser/cockroach.log 2>&1
            fi
        done
    fi
    
    # Sleep for 5 minutes
    sleep 300
done
