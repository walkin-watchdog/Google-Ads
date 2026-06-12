# Use the official Bun image
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# Copy package files first for caching
COPY package.json bun.lock* ./

# Install dependencies in the backend folder
WORKDIR /app
RUN bun install

# Copy all source files
WORKDIR /app
COPY . .

# Set working directory back to backend for running
WORKDIR /app

# Set environment variables
ENV PORT=7860
ENV NODE_ENV=production

# Expose port 7860 (standard for HuggingFace Spaces)
EXPOSE 7860

# Start the server
CMD ["bun", "run", "start"]