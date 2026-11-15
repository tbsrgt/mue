       IDENTIFICATION DIVISION.
       PROGRAM-ID. IBANCHK.
       AUTHOR. PAYMENTS TEAM.
       DATE-WRITTEN. 11/2008.
      *----------------------------------------------------------------
      * BENEFICIARY IBAN FORMAT CHECK : COUNTRY, CHECK DIGITS, LENGTH
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
      *    EXPECTED IBAN LENGTH FOR THE COUNTRY
       77  WS-EXPECTED-LEN         PIC 9(2).
       LINKAGE SECTION.
           COPY XFERREC.
       01  LK-RESULT.
           05  LK-IBAN-OK          PIC X.
               88  IBAN-VALID      VALUE 'Y'.
               88  IBAN-INVALID    VALUE 'N'.
       PROCEDURE DIVISION USING XFER-REC LK-RESULT.
       0000-CHECK.
           SET IBAN-VALID TO TRUE
           EVALUATE XFER-IBAN-COUNTRY
              WHEN 'FR'
              WHEN 'MC'
                 MOVE 27 TO WS-EXPECTED-LEN
              WHEN 'DE'
                 MOVE 22 TO WS-EXPECTED-LEN
              WHEN 'BE'
                 MOVE 16 TO WS-EXPECTED-LEN
              WHEN 'ES'
                 MOVE 24 TO WS-EXPECTED-LEN
              WHEN OTHER
                 MOVE ZERO TO WS-EXPECTED-LEN
           END-EVALUATE
           IF WS-EXPECTED-LEN = ZERO
              OR XFER-IBAN-LENGTH NOT = WS-EXPECTED-LEN
              OR XFER-IBAN-CHECK < 2 OR > 98
              SET IBAN-INVALID TO TRUE
           END-IF
           GOBACK.
