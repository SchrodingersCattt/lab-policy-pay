FROM node:20-slim AS assets
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY labpolicy ./labpolicy
RUN pip install --no-cache-dir uv==0.10.0 && uv sync --locked --no-dev --no-editable --python 3.11
COPY --from=assets /build/node_modules/ag-grid-community ./node_modules/ag-grid-community
ENV HOST=0.0.0.0 PORT=50002 PATH="/app/.venv/bin:$PATH"
EXPOSE 50002
CMD ["python", "-m", "labpolicy.app"]
