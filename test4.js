let wbSteps = [{type: 'warmup'}];
function wbRemoveStep(idx, subIdx = null) {
    if (subIdx === null) {
        wbSteps.splice(idx, 1);
    } else {
        wbSteps[idx].steps.splice(subIdx, 1);
    }
}
wbRemoveStep(0, null);
console.log(JSON.stringify(wbSteps));
