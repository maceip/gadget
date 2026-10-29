# Drives the hook functions directly; run with: zsh -f driver.zsh <path to gadget.zsh>
source $1

# Sourcing must register both hooks. Then unregister them: zsh also fires preexec
# for script lines, and this driver calls the functions explicitly instead.
(( ${preexec_functions[(Ie)_gadget_preexec]} )) || { print -u2 "preexec hook not registered"; exit 1 }
(( ${precmd_functions[(Ie)_gadget_precmd]} )) || { print -u2 "precmd hook not registered"; exit 1 }
add-zsh-hook -d preexec _gadget_preexec
add-zsh-hook -d precmd _gadget_precmd

_gadget_preexec 'echo plain'; true; _gadget_precmd
_gadget_preexec 'echo "quoted" back\slash'; true; _gadget_precmd
_gadget_preexec $'echo line1\necho line2'; true; _gadget_precmd
_gadget_preexec 'echo héllo 日本'; true; _gadget_precmd
_gadget_preexec 'make build'; (exit 3); _gadget_precmd
_gadget_preexec ' export SECRET=skip-me'; true; _gadget_precmd
_gadget_preexec $'tab\there\x01ctl'; true; _gadget_precmd
# precmd without a preceding preexec (empty prompt) must not write a line.
true; _gadget_precmd
