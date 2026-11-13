"""Conversa com a IA Pessoal pela linha de comando (sem abrir o painel).

Uso:  python scripts/testar_conversa.py "mensagem" [sessao]
Cria uma copia temporaria do workflow (id testeIaPess001) trocando o chat por uma mensagem fixa.
"""
import json, subprocess, sys, os, pathlib

PROJ = pathlib.Path(__file__).resolve().parent.parent
TMP = pathlib.Path(os.environ.get("TEMP", "/tmp"))
msg = sys.argv[1]
sessao = sys.argv[2] if len(sys.argv) > 2 else "teste-cli"

wf = json.load(open(PROJ / "workflows" / "ia-pessoal.json", encoding="utf8"))
wf["id"] = "testeIaPess001"
wf["name"] = "TESTE IA Pessoal (cli)"
wf["active"] = False
for n in wf["nodes"]:
    if n["name"] == "Chat":
        n.update({"type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "parameters": {}})
        n.pop("webhookId", None)
    if n["name"] == "IA Pessoal":
        n["parameters"]["options"]["enableStreaming"] = False
        n["parameters"]["options"]["returnIntermediateSteps"] = True
wf["nodes"].append({"id": "d0000000-0000-4000-8000-000000000001", "name": "Mensagem",
                    "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [150, 0],
                    "parameters": {"jsCode": "return [{json:" + json.dumps({"chatInput": msg, "sessionId": sessao}) + "}]"}})
wf["connections"]["Chat"] = {"main": [[{"node": "Mensagem", "type": "main", "index": 0}]]}
wf["connections"]["Mensagem"] = {"main": [[{"node": "IA Pessoal", "type": "main", "index": 0}]]}
(TMP / "teste-ia.json").write_text(json.dumps(wf, ensure_ascii=False), encoding="utf8")

env = dict(os.environ, MSYS_NO_PATHCONV="1")
def dc(*a, **k):
    return subprocess.run(["docker", "compose", *a], cwd=PROJ, env=env, capture_output=True, text=True, encoding="utf8", errors="replace", **k)
dc("cp", str(TMP / "teste-ia.json"), "n8n:/tmp/teste-ia.json")
r = dc("exec", "-T", "n8n", "n8n", "import:workflow", "--input=/tmp/teste-ia.json")
if "Success" not in r.stdout + r.stderr:
    print("IMPORT FALHOU", r.stdout, r.stderr); sys.exit(1)
r = dc("exec", "-T", "-e", "N8N_RUNNERS_BROKER_PORT=5690", "n8n", "n8n", "execute", "--id=testeIaPess001", "--rawOutput")
t = r.stdout
try:
    d = json.loads(t[t.index("{"):])
except Exception:
    print("SAIDA:", t[-3000:], r.stderr[-2000:]); sys.exit(1)
rd = d["data"]["resultData"]
if rd.get("error"):
    print("ERRO:", json.dumps(rd["error"], ensure_ascii=False)[:1500])
for nome, runs in rd["runData"].items():
    if nome in ("Chat", "Mensagem"):
        continue
    for run in runs:
        st = run.get("executionStatus")
        if nome == "IA Pessoal":
            out = run.get("data", {}).get("main", [[{}]])[0]
            if out:
                j = out[0]["json"]
                for s in j.get("intermediateSteps", []):
                    a = s.get("action", {})
                    print(f"  [ferramenta] {a.get('tool')} {json.dumps(a.get('toolInput'), ensure_ascii=False)[:200]}")
                print("\nIA >>", j.get("output"))
        elif run.get("error"):
            print(f"  [{nome}] ERRO {run['error'].get('message')}")
        else:
            print(f"  [{nome}] {st}")
