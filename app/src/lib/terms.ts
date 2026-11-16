//the notice before the first swap: shown once per browser (and per wallet module), until the user agreed. Storage can
//be blocked (private windows): then the agreement lasts until the page reloads.
const key = 'nexus-dex:terms';
const version = '1'; //raise when the notice changes in substance, so everyone reads it again
let agreedHere = false;

export function termsAccepted(): boolean {
  if (agreedHere) {
    return true;
  }
  try {
    return localStorage.getItem(key) === version;
  } catch {
    return false;
  }
}

export function acceptTerms() {
  agreedHere = true;
  try {
    localStorage.setItem(key, version);
  } catch {
    //storage blocked: agreed for this page load
  }
}
