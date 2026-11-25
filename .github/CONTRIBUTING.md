# Reporting an issue

## Before reporting

If you have found an issue with BACED please make sure that BACED really is the cause of the problem. To do this try to reproduce the issue with using only `@CBA_A3`, `@ace` and `@baced` on a newly created mission.

Indicate if the issue appears on stable or development version. In case it is the development version, please also include the commit SHA-1 hash.

**Please note:**
- BACED is a patch mod loaded alongside ACE3. If the issue also happens without `@baced` (only `@CBA_A3` and `@ace`), it comes from ACE3 rather than from BACED. Report it to the [ACE3 issue tracker](https://github.com/acemod/ACE3/issues) instead.
- If the error happens when using a <b>third-party mod</b> contact the author of the appropriate mod and report the issue there.

## Reporting the issue

Head over to the [BACED GitHub issue tracker](https://github.com/Black-Templars-Team/BACED/issues) and press the [New issue](https://github.com/Black-Templars-Team/BACED/issues/new/choose) button in the top right corner. Add a descriptive title and complete the issue template.

A video of the issue might be helpful in resolving it faster.

# Feature Requests

## Background
BACED only changes ACE3 where 40K needs it. Features that belong to ACE3 in general are developed upstream, so please refrain from requesting them here. Use the [ACE3 issue tracker](https://github.com/acemod/ACE3/issues) for those instead.

## Requesting a feature
In order to avoid duplicates and keep the issue tracker organized, search the [BACED issue tracker](https://github.com/Black-Templars-Team/BACED/issues) for similar suggestions before making a new request. Please don't reiterate requests for features that had already been accepted for inclusion, or those which were disregarded earlier.

If your request is new, open a [feature request](https://github.com/Black-Templars-Team/BACED/issues/new/choose). It will be discussed and evaluated there.

# Contributing to the project

We welcome anyone to contribute to this repository. Issues that we are actively seeking help with, are marked as [`help wanted`](https://github.com/Black-Templars-Team/BACED/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22). Feel free to pick up any of those issues.

## Pull Request process

When contributing to this repository, please first discuss the change you wish to make via issue or [Discord](https://discord.gg/blacktemplar-a3) with the BACED maintainers before making a change. This may not be necessary if you are contributing for something which has an existing issue in our repository already.

1. Please make a pull request (PR) against the `baced` branch as early as possible. This lets us help you in the process of developing it. When opening a work in progress pull request, use GitHub's draft feature. This will mark the PR as a work in progress and will prevent it from being merged until you mark it as ready for review.
2. Describe what this pull request will do and how it solves this in the description of your PR. A clear intent and description of the way the issue is resolved will help us to review the PR more efficiently.
3. Please follow our [development guide](https://github.com/Black-Templars-Team/BACED/wiki/Setting-Up-the-Development-Environment). In particular, change ACE3 behaviour by overriding only the functions you need with `tools/ace_override.py`, never by copying whole ACE3 addons.

The `master` branch mirrors upstream ACE3 and is only used to sync with it; don't open pull requests against it.

### Notes

Please note that all contributors to this project are volunteers and do this in their own time. This means that issues and/or PRs may be open for a long time before being picked up and reviewed. We try to keep this time as short as possible, but some times things may fall short. If you feel that an issue or PR has not received attention, please comment asking for a review.

## Assistance with contributing

If you require assistance with contributing, ask on our [Discord](https://discord.gg/blacktemplar-a3). Additional documentation can be found on our [wiki](https://github.com/Black-Templars-Team/BACED/wiki).
