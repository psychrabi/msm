MSM Agent installer kit
=========================

On the AGENT machine (elevated PowerShell), in this folder:

  1. Make a certificate (skip if the agent already has one):
       .\new-agent-cert.ps1
     This writes cert.pem + key.pem here.

  2. Install (generates the cert for you if you add -GenerateCert):
       .\install-agent.ps1 -GenerateCert
     Or without -GenerateCert if cert.pem/key.pem already exist in
     C:\ProgramData\MSM\agent\tls\.
     Prints the access token at the end -- save it.

On each APP machine (elevated PowerShell):

  3. Copy this machine's cert.pem next to install-app-cert.ps1, then:
       .\install-app-cert.ps1

In the MSM app:

  4. Add https://<AGENT-IP>:40123 with the access token from step 2.
