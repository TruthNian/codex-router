// A redirect may arrive after the first origin consumed a generation POST.
// Neither following it nor exposing Location to a caller preserves the known
// delivery boundary. Endpoint configuration must name the final API address.
function generationRedirectError() {
  const error = new Error("The upstream redirected a generation request; configure its final API endpoint.");
  error.code = "upstream_redirect_refused";
  error.status = 502;
  return error;
}

// An owned intermediary can encode the refusal as JSON rather than a 3xx.
// A body marker can deny replay; it never grants permission to send again.
export function generationRedirectRefusal(bodyText) {
  try {
    return JSON.parse(bodyText)?.error?.type === "provider_redirect_refused"
      ? generationRedirectError() : undefined;
  } catch {
    return undefined;
  }
}

export async function rejectGenerationRedirect(response) {
  if (response?.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw generationRedirectError();
  }
  return response;
}
