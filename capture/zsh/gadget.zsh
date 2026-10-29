# gadget forward capture for zsh (AGENTS.md section 10, Phase 0 step 3).
#
# Appends one JSON line per command to ~/.gadget/capture/zsh.jsonl:
#   {"v":1,"start_ms":N,"end_ms":N,"cwd":"...","cmd":"...","exit":N}
#
# Install: add to ~/.zshrc
#   source /path/to/gadget/capture/zsh/gadget.zsh
#
# Pure zsh: no subprocess per command (one chmod per new shell if the log exists).
# Never breaks the shell: every error is swallowed. Commands starting with a space
# are not recorded. The log is created with mode 600 in a mode 700 directory, and an
# existing log is reset to 600; it holds whatever you type, secrets included.
# Override the path with GADGET_ZSH_LOG.

zmodload zsh/datetime 2>/dev/null || return 0
zmodload -F zsh/files b:zf_mkdir 2>/dev/null
setopt EXTENDED_HISTORY INC_APPEND_HISTORY_TIME 2>/dev/null

typeset -g _gadget_cmd=""
typeset -g _gadget_start=""
typeset -g _gadget_log="${GADGET_ZSH_LOG:-$HOME/.gadget/capture/zsh.jsonl}"

# Ensure the capture directory (700) and log file (600) exist immediately and stay private.
{
  if [[ ! -e $_gadget_log ]]; then
    if (( $+builtins[zf_mkdir] )); then
      zf_mkdir -p -m 700 -- "${_gadget_log:h}"
    else
      mkdir -p -m 700 -- "${_gadget_log:h}"
    fi
    ( umask 077; : >> "$_gadget_log" )
  else
    chmod 600 -- "$_gadget_log"
  fi
} 2>/dev/null

# Sets REPLY to $1 escaped for a JSON string.
_gadget_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//[[:cntrl:]]/}
  REPLY=$s
}

_gadget_preexec() {
  _gadget_cmd=${1:-$3}
  _gadget_start=$EPOCHREALTIME
}

_gadget_precmd() {
  local exit_code=$?
  [[ -n $_gadget_start ]] || return 0
  local cmd=$_gadget_cmd start=$_gadget_start end=$EPOCHREALTIME
  _gadget_cmd=""
  _gadget_start=""
  [[ $cmd == ' '* ]] && return 0
  {
    local -i start_ms=$(( start * 1000 )) end_ms=$(( end * 1000 ))
    local jcmd jcwd
    _gadget_json_escape "$cmd"; jcmd=$REPLY
    _gadget_json_escape "$PWD"; jcwd=$REPLY
    if [[ ! -e $_gadget_log ]]; then
      if (( $+builtins[zf_mkdir] )); then
        zf_mkdir -p -m 700 -- "${_gadget_log:h}"
      else
        mkdir -p -m 700 -- "${_gadget_log:h}"
      fi
      ( umask 077; : >> "$_gadget_log" )
    fi
    print -r -- "{\"v\":1,\"start_ms\":$start_ms,\"end_ms\":$end_ms,\"cwd\":\"$jcwd\",\"cmd\":\"$jcmd\",\"exit\":$exit_code}" >> "$_gadget_log"
  } 2>/dev/null
  return 0
}

autoload -Uz add-zsh-hook 2>/dev/null && {
  add-zsh-hook preexec _gadget_preexec
  add-zsh-hook precmd _gadget_precmd
  # Prepend _gadget_precmd so earlier precmd hooks (e.g. starship) do not reset $? to 0 first.
  precmd_functions=(_gadget_precmd ${precmd_functions:#_gadget_precmd})
}
