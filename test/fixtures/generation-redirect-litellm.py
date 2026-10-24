"""Optional loopback-only probe of the installed LiteLLM router retry policy."""
import asyncio
import ipaddress
import json
import os
import socket
import sys

for name in list(os.environ):
    if name.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
        del os.environ[name]
os.environ["NO_PROXY"] = "*"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

original_connect = socket.socket.connect
original_getaddrinfo = socket.getaddrinfo
def loopback_address(host):
    if host in (None, "localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False

def loopback_getaddrinfo(host, *args, **kwargs):
    if not loopback_address(host):
        raise RuntimeError("This regression probe permits only loopback DNS")
    return original_getaddrinfo(host, *args, **kwargs)

def loopback_connect(sock, address):
    if isinstance(address, tuple) and not loopback_address(address[0]):
        raise RuntimeError("This regression probe permits only loopback connections")
    return original_connect(sock, address)
socket.socket.connect = loopback_connect
socket.getaddrinfo = loopback_getaddrinfo
if os.name == "nt":
    # The selector loop uses socket.connect; Proactor ConnectEx bypasses it.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import litellm
from litellm import Router
litellm.telemetry = False
litellm.suppress_debug_info = True

async def main():
    router = Router(model_list=[{"model_name": "redirect-probe", "litellm_params": {
        "model": "openai/" + sys.argv[2], "api_base": sys.argv[1],
        "api_key": os.environ["MODEL_ROUTER_TEST_INTERNAL_KEY"], "timeout": 10,
    }}], num_retries=2, retry_after=0, disable_cooldowns=True)
    try:
        await router.acompletion(model="redirect-probe", messages=[{"role": "user", "content": "local synthetic regression"}])
    except Exception as error:
        status = getattr(error, "status_code", None)
        print(json.dumps({"status": status, "kind": type(error).__name__, "detail": str(error)[:1000]}))
        return 0 if status == 400 else 1
    return 1

raise SystemExit(asyncio.run(main()))
