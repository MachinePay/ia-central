# n8n da IA Central: ao iniciar, cria as tabelas, o admin, as credenciais e importa/ativa os workflows.
# Build a partir da raiz do repositorio:  docker build -f deploy/n8n/Dockerfile .
FROM n8nio/n8n:2.47.5

USER root
COPY db/init/ /opt/ia/db/
COPY workflows/ /opt/ia/workflows/
COPY deploy/n8n/preparar.js deploy/n8n/iniciar.sh /opt/ia/
RUN rm -f /opt/ia/workflows/credenciais.json \
 && sed -i 's/\r$//' /opt/ia/iniciar.sh \
 && chmod +x /opt/ia/iniciar.sh \
 && chown -R node:node /opt/ia
USER node

ENV GENERIC_TIMEZONE=America/Sao_Paulo \
    TZ=America/Sao_Paulo \
    DB_TYPE=postgresdb \
    N8N_PORT=5678 \
    N8N_PROTOCOL=https \
    N8N_SECURE_COOKIE=true \
    N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    N8N_PROXY_HOPS=1

# Memoria: o plano do Render tem 512 MB; sem isso o Node para em ~250 MB e o n8n cai ao iniciar
ENV NODE_OPTIONS=--max-old-space-size=400 \
    N8N_RUNNERS_MAX_OLD_SPACE_SIZE=384 \
    N8N_PAYLOAD_SIZE_MAX=64
# (audio longo do WhatsApp chega em base64 no webhook: precisa de folga no tamanho e na memoria do Code)

# Desliga o que nao usamos (menos memoria e menos rede)
ENV N8N_DIAGNOSTICS_ENABLED=false \
    N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    N8N_TEMPLATES_ENABLED=false \
    N8N_PERSONALIZATION_ENABLED=false \
    N8N_NATIVE_PYTHON_RUNNER=false

# Historico de execucoes: guarda 7 dias
ENV EXECUTIONS_DATA_PRUNE=true \
    EXECUTIONS_DATA_MAX_AGE=168

EXPOSE 5678
ENTRYPOINT ["tini", "--", "/opt/ia/iniciar.sh"]
