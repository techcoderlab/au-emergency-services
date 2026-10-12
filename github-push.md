Command Cheat-Sheet for Git Submodule Management & Workflows
1. Cloning the Project on a New Machine
bash
# Clone the repository along with all its submodules recursively
git clone --recurse-submodules https://github.com/techcoderlab/au-emergency-services.git
# If already cloned without submodules, initialize and pull them:
git submodule update --init --recursive
2. Pulling the Latest Changes from All Submodules
bash
# Pull the latest changes for the root repo and update all submodules to match
git pull --recurse-submodules
# Or update all submodules to their remote latest on 'main':
git submodule update --remote --merge
3. Making Changes & Committing Inside a Specific Submodule
When you make changes inside a submodule folder (e.g. plumber/):

bash
# 1. Navigate into the submodule or use git -C
cd plumber
git add .
git commit -m "feat(plumber): describe your change"
git push origin main
cd ..
# 2. Update and push the root repository to lock the new submodule commit
git add plumber
git commit -m "chore: update plumber submodule reference"
git push origin main
4. Batch Committing and Pushing All Submodules at Once
bash
# Run status across all submodules
git submodule foreach 'git status -s'
# Push all submodules with unpushed commits before pushing root
git push --recurse-submodules=on-demand
5. Local Preview & Testing
bash
# Start a simple HTTP server from the root directory
python3 -m http.server 8080
# Landing pages will be accessible at:
# Emergency  -> http://localhost:8080/emergency/
# Plumber    -> http://localhost:8080/plumber/
# Electrical -> http://localhost:8080/electrical/