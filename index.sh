#!/bin/bash

# Resolve the actual path of the script, even if it's a symlink
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # Resolve $SOURCE until it's no longer a symlink
    DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
    SOURCE="$(readlink "$SOURCE")"
    # If $SOURCE was a relative symlink, resolve it relative to the symlink's directory
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

# Function to calculate Base64-encoded SHA256 hash
calculate_sha256() {
    if command -v shasum > /dev/null; then
        echo -n "$1" | shasum -a 256 | cut -d ' ' -f 1 | xxd -r -p | base64
    elif command -v sha256sum > /dev/null; then
        echo -n "$1" | sha256sum | cut -d ' ' -f 1 | xxd -r -p | base64
    else
        echo "Error: Neither shasum nor sha256sum is available." >&2
        exit 1
    fi
}

# URL encoding function
urlencode() {
    local string="$1"
    local length="${#string}"
    local encoded=""
    local pos c o
    
    for (( pos=0; pos<length; pos++ )); do
        c="${string:$pos:1}"
        case "$c" in
            [-_.~a-zA-Z0-9]) 
                encoded+="$c" 
                ;;
            *) 
                printf -v o '%%%02x' "'$c"
                encoded+="$o"
                ;;
        esac
    done
    
    echo "$encoded"
}

# Get the configuration file to read the port
CONFIG_FILE="${HOME}/http/.braidfs/config"
if [ -f "$CONFIG_FILE" ]; then
    PORT=$(grep -o '"port":[^,}]*' "$CONFIG_FILE" | sed 's/"port"://; s/ //g')
    if [ -z "$PORT" ]; then
        PORT=45678  # Default port if not found in config
    fi
else
    PORT=45678  # Default port if config file doesn't exist
fi

# Check if the first argument is "editing"
if [ "$1" = "editing" ]; then
    FILENAME="$2"
    # Convert to absolute path if needed
    if [[ ! "$FILENAME" = /* ]]; then
        FILENAME="$(pwd)/$FILENAME"
    fi
    
    # Read input from stdin
    INPUT=$(cat)
    
    # Calculate SHA256 hash
    HASH=$(calculate_sha256 "$INPUT")
    
    # Make HTTP request
    RESPONSE=$(curl -s "http://localhost:${PORT}/.braidfs/get_version/$(urlencode "$FILENAME")/$(urlencode "$HASH")")
    echo "$RESPONSE"
    exit 0

# Check if the first argument is "edited"
elif [ "$1" = "edited" ]; then
    FILENAME="$2"
    # Convert to absolute path if needed
    if [[ ! "$FILENAME" = /* ]]; then
        FILENAME="$(pwd)/$FILENAME"
    fi
    
    PARENT_VERSION="$3"
    
    # Read input from stdin
    INPUT=$(cat)
    
    # Make HTTP request
    RESPONSE=$(curl -s -X PUT -d "$INPUT" "http://localhost:${PORT}/.braidfs/set_version/$(urlencode "$FILENAME")/$(urlencode "$PARENT_VERSION")")
    echo "$RESPONSE"
    exit 0

# For all other commands, pass through to the Node.js script
else
    node "$SCRIPT_DIR/index.js" "$@"
fi
